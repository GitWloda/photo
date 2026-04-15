#!/usr/bin/env python3
"""Worker IA: riceve un asset_id come argomento, chiama Ollama e salva la descrizione nel DB.

Utilizzo:
    python3 bin/worker_ai.py <asset_id>

Viene lanciato in parallelo da update_db.sh tramite GNU parallel.
Gestisce SQLITE_BUSY con retry e backoff esponenziale.
"""

import os
import sys
import sqlite3
import subprocess
import time

# ---------------------------------------------------------------------------
# Risoluzione paths
# ---------------------------------------------------------------------------
ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
ENV_FILE = os.path.join(ROOT_DIR, "config", "app.env")


def load_env(path: str) -> dict:
    """Carica le variabili da un file .env in stile bash (KEY=VALUE)."""
    cfg: dict = {}
    with open(path) as f:
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

# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------
DB_TIMEOUT = 30  # secondi di attesa massima per il lock SQLite
DB_RETRIES = 6   # tentativi in caso di OperationalError "locked"


def db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=DB_TIMEOUT, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    # WAL già abilitato da init_db.sh, ma ripetiamo per sicurezza
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def write_description(asset_id: int, desc: str) -> None:
    """Scrive la descrizione IA nel DB con retry/backoff esponenziale."""
    for attempt in range(DB_RETRIES):
        try:
            conn = db_connect()
            with conn:  # transazione atomica: commit ok, eccezione -> rollback
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
                            SELECT id FROM ai_descriptions
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
            return  # successo
        except sqlite3.OperationalError as exc:
            if "locked" in str(exc).lower() and attempt < DB_RETRIES - 1:
                wait = 0.3 * (2 ** attempt)  # 0.3s, 0.6s, 1.2s, 2.4s ...
                print(
                    f"[WARN] asset_id={asset_id} DB locked, retry {attempt+1}/{DB_RETRIES} "
                    f"tra {wait:.1f}s",
                    file=sys.stderr,
                    flush=True,
                )
                time.sleep(wait)
            else:
                raise


# ---------------------------------------------------------------------------
# Logica principale
# ---------------------------------------------------------------------------

def get_file_path(asset_id: int) -> str | None:
    """Recupera l'absolute_path del file dal DB."""
    conn = db_connect()
    row = conn.execute(
        "SELECT absolute_path FROM asset_files WHERE asset_id = ? LIMIT 1",
        (asset_id,),
    ).fetchone()
    conn.close()
    return row["absolute_path"] if row else None


def already_has_description(asset_id: int) -> bool:
    """Controlla se l'asset ha già una descrizione valida (evita doppioni)."""
    conn = db_connect()
    row = conn.execute(
        "SELECT ai_description_id FROM assets WHERE id = ? LIMIT 1",
        (asset_id,),
    ).fetchone()
    conn.close()
    return row is not None and row["ai_description_id"] is not None


def call_ollama(abs_path: str) -> str:
    """Chiama generate_description.sh e restituisce la descrizione."""
    result = subprocess.run(
        [GEN_SCRIPT, abs_path],
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def process(asset_id: int) -> None:
    if already_has_description(asset_id):
        print(f"[SKIP] asset_id={asset_id} ha già una descrizione.", flush=True)
        return

    abs_path = get_file_path(asset_id)
    if not abs_path:
        print(f"[ERR]  asset_id={asset_id} nessun file trovato nel DB.", file=sys.stderr, flush=True)
        return

    if not os.path.isfile(abs_path):
        print(f"[ERR]  asset_id={asset_id} file non esistente: {abs_path}", file=sys.stderr, flush=True)
        return

    print(f"[RUN]  asset_id={asset_id} -> {os.path.basename(abs_path)}", flush=True)
    desc = call_ollama(abs_path)

    if not desc:
        print(f"[WARN] asset_id={asset_id} descrizione vuota, skip.", file=sys.stderr, flush=True)
        return

    write_description(asset_id, desc)
    print(f"[OK]   asset_id={asset_id} descrizione salvata ({len(desc)} caratteri).", flush=True)


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
