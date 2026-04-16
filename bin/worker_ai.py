#!/usr/bin/env python3
"""
Worker IA: riceve un asset_id come argomento, chiama Ollama e salva la descrizione nel DB.

Migliorie:
- retry automatico se la descrizione è vuota;
- log completo di stdout/stderr/return code;
- backoff semplice tra i tentativi;
- evita di perdere il motivo reale del fallimento.
"""

import os
import sys
import sqlite3
import subprocess
import time
from datetime import datetime

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
ENV_FILE = os.path.join(ROOT_DIR, "config", "app.env")


def load_env(path: str) -> dict:
    cfg = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            cfg[key.strip()] = value.strip().strip('"').strip("'")
    return cfg


cfg = load_env(ENV_FILE)

DB_PATH = cfg.get("DB_PATH", "db/gallery.db")
if not os.path.isabs(DB_PATH):
    DB_PATH = os.path.join(ROOT_DIR, DB_PATH)

OLLAMA_MODEL = cfg.get("OLLAMA_MODEL", "gemma3:12b")
LANGUAGE = cfg.get("LANGUAGE", "it")
GEN_SCRIPT = os.path.join(ROOT_DIR, "bin", "generate_description.sh")

DB_TIMEOUT = 30
DB_RETRIES = 6
DESC_RETRIES = int(cfg.get("DESC_RETRIES", "3"))
DESC_SLEEP = float(cfg.get("DESC_SLEEP", "1.5"))

GREEN = "\033[32m"
WHITE = "\033[97m"
YELLOW = "\033[33m"
RED = "\033[31m"
RESET = "\033[0m"

def _ts() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

def log_run(msg: str) -> None:
    print(f"{WHITE}[{_ts()}] [RUN]  {msg}{RESET}", flush=True)

def log_ok(msg: str) -> None:
    print(f"{GREEN}[{_ts()}] [OK]   {msg}{RESET}", flush=True)

def log_warn(msg: str) -> None:
    print(f"{YELLOW}[{_ts()}] [WARN] {msg}{RESET}", file=sys.stderr, flush=True)

def log_err(msg: str) -> None:
    print(f"{RED}[{_ts()}] [ERR]  {msg}{RESET}", file=sys.stderr, flush=True)

def log_skip(msg: str) -> None:
    print(f"{YELLOW}[{_ts()}] [SKIP] {msg}{RESET}", flush=True)


def db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=DB_TIMEOUT, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def write_description(asset_id: int, desc: str) -> None:
    for attempt in range(DB_RETRIES):
        try:
            conn = db_connect()
            with conn:
                conn.execute(
                    """
                    INSERT INTO ai_descriptions
                        (asset_id, model, language, description, created_at)
                    VALUES
                        (?, ?, ?, ?, strftime('%s','now'))
                    """,
                    (asset_id, OLLAMA_MODEL, LANGUAGE, desc),
                )
                conn.execute(
                    """
                    UPDATE assets
                    SET ai_description_id = (
                            SELECT id
                            FROM ai_descriptions
                            WHERE asset_id = ?
                            ORDER BY created_at DESC
                            LIMIT 1
                        ),
                        updated_at = strftime('%s','now')
                    WHERE id = ?
                    """,
                    (asset_id, asset_id),
                )
            conn.close()
            return
        except sqlite3.OperationalError as exc:
            if "locked" in str(exc).lower() and attempt < DB_RETRIES - 1:
                wait = 0.3 * (2 ** attempt)
                print(
                    f"[WARN] asset_id={asset_id} DB locked, retry {attempt + 1}/{DB_RETRIES} "
                    f"tra {wait:.1f}s",
                    file=sys.stderr,
                    flush=True,
                )
                time.sleep(wait)
            else:
                raise


def get_file_path(asset_id: int) -> str | None:
    conn = db_connect()
    row = conn.execute(
        "SELECT absolute_path FROM asset_files WHERE asset_id = ? LIMIT 1",
        (asset_id,),
    ).fetchone()
    conn.close()
    return row["absolute_path"] if row else None


def already_has_description(asset_id: int) -> bool:
    conn = db_connect()
    row = conn.execute(
        "SELECT ai_description_id FROM assets WHERE id = ? LIMIT 1",
        (asset_id,),
    ).fetchone()
    conn.close()
    return row is not None and row["ai_description_id"] is not None


def call_ollama(abs_path: str) -> tuple[str, int, str, str]:
    result = subprocess.run(
        [GEN_SCRIPT, abs_path],
        capture_output=True,
        text=True,
    )
    stdout = result.stdout.strip()
    stderr = result.stderr.strip()
    return stdout, result.returncode, stderr, result.args[0] if isinstance(result.args, list) and result.args else str(result.args)


def call_ollama_with_retry(abs_path: str, retries: int = DESC_RETRIES) -> str:
    last_stdout = ""
    last_stderr = ""
    last_rc = 0

    for attempt in range(1, retries + 1):
        stdout, rc, stderr, _ = call_ollama(abs_path)
        last_stdout = stdout
        last_stderr = stderr
        last_rc = rc

        if rc == 0 and stdout:
            return stdout

        log_warn(
            f"generate_description fallita/vuota per file={abs_path} "
            f"tentativo {attempt}/{retries} rc={rc}"
        )

        if stdout:
            log_warn(f"stdout: {stdout}")

        if stderr:
            log_warn(f"stderr: {stderr}")

        if attempt < retries:
            time.sleep(DESC_SLEEP * attempt)

    log_err(
        f"generate_description esauriti i retry per file={abs_path} "
        f"(rc={last_rc})"
    )
    if last_stdout:
        log_err(f"ultimo stdout: {last_stdout}")
    if last_stderr:
        log_err(f"ultimo stderr: {last_stderr}")

    return ""


def process(asset_id: int) -> None:
    if already_has_description(asset_id):
        log_skip(f"asset_id={asset_id} ha già una descrizione.")
        return

    abs_path = get_file_path(asset_id)
    if not abs_path:
        log_err(f"asset_id={asset_id} nessun file trovato nel DB.")
        return

    if not os.path.isfile(abs_path):
        log_err(f"asset_id={asset_id} file non esistente: {abs_path}")
        return

    log_run(f"asset_id={asset_id} -> {os.path.basename(abs_path)}")

    desc = call_ollama_with_retry(abs_path)

    if not desc:
        log_warn(f"asset_id={asset_id} descrizione vuota, skip.")
        return

    try:
        write_description(asset_id, desc)
    except Exception as exc:
        log_err(f"asset_id={asset_id} errore salvataggio DB: {exc}")
        raise

    log_ok(f"asset_id={asset_id} descrizione salvata ({len(desc)} caratteri).")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(f"Uso: {sys.argv[0]} <asset_id>", file=sys.stderr)
        sys.exit(1)

    try:
        aid = int(sys.argv[1])
    except ValueError:
        print(f"Errore: asset_id deve essere un intero, ricevuto: {sys.argv[1]}", file=sys.stderr)
        sys.exit(1)

    process(aid)