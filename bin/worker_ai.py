#!/usr/bin/env python3
"""
Worker IA: riceve un asset_id, chiama Ollama e salva la descrizione nel DB.
- Skip automatico per file video (Ollama vision non li supporta)
- Throttle configurabile tra chiamate per non sovraccaricare Ollama
- Retry con backoff esponenziale
"""

import os
import random
import sqlite3
import subprocess
import sys
import time
from datetime import datetime

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from lib.config import ROOT_DIR, load_env

cfg = load_env()

VIDEO_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".ts", ".m4v", ".3gp"}

DB_PATH = cfg.get("DB_PATH", "db/gallery.db")
if not os.path.isabs(DB_PATH):
    DB_PATH = os.path.join(ROOT_DIR, DB_PATH)

OLLAMA_MODEL = cfg.get("OLLAMA_MODEL", "gemma3:12b")
LANGUAGE = cfg.get("LANGUAGE", "it")
GEN_SCRIPT = os.path.join(ROOT_DIR, "bin", "generate_description.sh")

DB_TIMEOUT = 30
DB_RETRIES = 6
DESC_RETRIES = int(cfg.get("DESC_RETRIES", "3"))
DESC_SLEEP = float(cfg.get("DESC_SLEEP", "2.0"))
WORKER_STAGGER = float(cfg.get("WORKER_STAGGER", "3.0"))

GREEN = "\033[32m"
WHITE = "\033[97m"
YELLOW = "\033[33m"
RED = "\033[31m"
RESET = "\033[0m"


def _ts() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def log_run(msg):
    print(f"{WHITE}[{_ts()}] [RUN]  {msg}{RESET}", flush=True)


def log_ok(msg):
    print(f"{GREEN}[{_ts()}] [OK]   {msg}{RESET}", flush=True)


def log_warn(msg):
    print(f"{YELLOW}[{_ts()}] [WARN] {msg}{RESET}", file=sys.stderr, flush=True)


def log_err(msg):
    print(f"{RED}[{_ts()}] [ERR]  {msg}{RESET}", file=sys.stderr, flush=True)


def log_skip(msg):
    print(f"{YELLOW}[{_ts()}] [SKIP] {msg}{RESET}", flush=True)


def db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=DB_TIMEOUT, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=15000")
    return conn


def already_has_description(asset_id: int) -> bool:
    conn = db_connect()
    try:
        row = conn.execute(
            "SELECT ai_description_id FROM assets WHERE id = ? LIMIT 1",
            (asset_id,),
        ).fetchone()
        return row is not None and row["ai_description_id"] is not None
    finally:
        conn.close()


def get_file_info(asset_id: int):
    conn = db_connect()
    try:
        row = conn.execute(
            """
            SELECT af.absolute_path, a.media_kind
            FROM asset_files af
            JOIN assets a ON a.id = af.asset_id
            WHERE af.asset_id = ?
            LIMIT 1
            """,
            (asset_id,),
        ).fetchone()
        if row:
            return row["absolute_path"], row["media_kind"]
        return None, None
    finally:
        conn.close()


def write_description(asset_id: int, desc: str) -> None:
    for attempt in range(DB_RETRIES):
        try:
            conn = db_connect()
            try:
                with conn:
                    cur = conn.execute(
                        """
                        INSERT INTO ai_descriptions
                            (asset_id, model, language, description, created_at)
                        VALUES
                            (?, ?, ?, ?, strftime('%s','now'))
                        """,
                        (asset_id, OLLAMA_MODEL, LANGUAGE, desc),
                    )
                    desc_id = cur.lastrowid

                    conn.execute(
                        """
                        UPDATE assets
                        SET ai_description_id = ?,
                            updated_at = strftime('%s','now')
                        WHERE id = ?
                        """,
                        (desc_id, asset_id),
                    )
            finally:
                conn.close()
            return
        except sqlite3.OperationalError as exc:
            if "locked" in str(exc).lower() and attempt < DB_RETRIES - 1:
                wait = 0.3 * (2 ** attempt)
                log_warn(
                    f"asset_id={asset_id} DB locked, retry {attempt+1}/{DB_RETRIES} tra {wait:.1f}s"
                )
                time.sleep(wait)
            else:
                raise


def is_video_file(abs_path: str) -> bool:
    ext = os.path.splitext(abs_path)[1].lower()
    return ext in VIDEO_EXTENSIONS


def call_ollama(abs_path: str):
    result = subprocess.run(
        [GEN_SCRIPT, abs_path],
        capture_output=True,
        text=True,
    )
    return result.stdout.strip(), result.returncode, result.stderr.strip()


def call_ollama_with_retry(abs_path: str) -> str:
    last_rc = 0
    last_stderr = ""

    for attempt in range(1, DESC_RETRIES + 1):
        stdout, rc, stderr = call_ollama(abs_path)
        last_rc = rc
        last_stderr = stderr

        if rc == 0 and stdout:
            return stdout

        log_warn(
            f"generate_description fallita/vuota per file={abs_path} "
            f"tentativo {attempt}/{DESC_RETRIES} rc={rc}"
        )
        if stderr:
            log_warn(f"stderr: {stderr}")

        if rc == 1 and ("unknown format" in stderr.lower() or "unknown format" in stdout.lower()):
            log_err(f"Ollama non supporta il formato: {abs_path} — skip permanente")
            return ""

        if rc in (7, 52):
            wait = DESC_SLEEP * (3 ** (attempt - 1))
            log_warn(
                f"Ollama irraggiungibile (rc={rc}), attendo {wait:.1f}s prima del prossimo tentativo..."
            )
            time.sleep(wait)
        elif attempt < DESC_RETRIES:
            time.sleep(DESC_SLEEP * attempt)

    log_err(f"generate_description esauriti i retry per file={abs_path} (rc={last_rc})")
    if last_stderr:
        log_err(f"ultimo stderr: {last_stderr}")
    return ""


def process(asset_id: int) -> None:
    time.sleep(random.uniform(0, WORKER_STAGGER))

    if already_has_description(asset_id):
        log_skip(f"asset_id={asset_id} ha già una descrizione.")
        return

    abs_path, media_kind = get_file_info(asset_id)
    if not abs_path:
        log_err(f"asset_id={asset_id} nessun file trovato nel DB.")
        return

    if not os.path.isfile(abs_path):
        log_err(f"asset_id={asset_id} file non esistente: {abs_path}")
        return

    if media_kind == "video" or is_video_file(abs_path):
        log_skip(
            f"asset_id={asset_id} è un video, descrizione AI non supportata: {os.path.basename(abs_path)}"
        )
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