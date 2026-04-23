#!/usr/bin/env python3
"""
worker_ai.py  -  elabora un singolo asset (immagine o video).

Per le IMMAGINI: usa Ollama Vision API per descrivere la thumbnail (o il
                 file originale se la thumbnail non esiste).
Per i VIDEO:     chiama generate_video_description.sh che estrae e descrive
                 i frame, poi sintetizza il risultato.

Uso:  python3 worker_ai.py <asset_id>
"""
import sys
import os
import json
import base64
import subprocess
import sqlite3
import urllib.request
import urllib.error


# ---------------------------------------------------------------------------
# Lettura app.env
# ---------------------------------------------------------------------------
def load_env(path: str) -> dict:
    env: dict = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            if '=' in line:
                key, _, val = line.lstrip('export ').partition('=')
                val = val.split('#')[0].strip().strip('"').strip("'")
                env[key.strip()] = val
    return env


ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
ENV_PATH = os.path.join(ROOT_DIR, 'config', 'app.env')
ENV = load_env(ENV_PATH)

OLLAMA_URL   = ENV.get('OLLAMA_URL', 'http://localhost:11434')
OLLAMA_MODEL = ENV.get('OLLAMA_MODEL', 'llava')
LANGUAGE     = ENV.get('LANGUAGE', 'italiano')

_db_path = ENV.get('DB_PATH', 'db/gallery.db')
DB_PATH  = _db_path if os.path.isabs(_db_path) else os.path.join(ROOT_DIR, _db_path)

_thumb = ENV.get('THUMB_DIR', 'data/thumbs')
THUMB_DIR = _thumb if os.path.isabs(_thumb) else os.path.join(ROOT_DIR, _thumb)

_photo_root = ENV.get('PHOTO_ROOT', 'photos')
PHOTO_ROOT  = _photo_root if os.path.isabs(_photo_root) else os.path.join(ROOT_DIR, _photo_root)

VIDEO_DESC_SCRIPT = os.path.join(ROOT_DIR, 'bin', 'generate_video_description.sh')

IMAGE_PROMPT = (
    f"Descrivi dettagliatamente questa foto in {LANGUAGE}. "
    "Descrivi persone, paesaggi, oggetti, atmosfera e qualsiasi dettaglio rilevante. "
    "Rispondi direttamente senza formule introduttive."
)


# ---------------------------------------------------------------------------
# Helpers DB
# ---------------------------------------------------------------------------
def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def fetch_asset(asset_id: int):
    conn = get_db()
    row = conn.execute("""
        SELECT a.id, a.media_kind, a.ai_description_id,
               f.absolute_path, f.thumb_path
          FROM assets a
          JOIN asset_files f ON f.asset_id = a.id
         WHERE a.id = ?
         LIMIT 1
    """, (asset_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def already_described(asset: dict) -> bool:
    return asset['ai_description_id'] is not None


def save_description(asset_id: int, description: str):
    conn = get_db()
    try:
        conn.execute("BEGIN IMMEDIATE")
        cur = conn.execute("""
            INSERT INTO ai_descriptions (asset_id, model, language, description, created_at)
            VALUES (?, ?, ?, ?, strftime('%s','now'))
        """, (asset_id, OLLAMA_MODEL, LANGUAGE, description))
        desc_id = cur.lastrowid
        conn.execute("""
            UPDATE assets
               SET ai_description_id = ?, updated_at = strftime('%s','now')
             WHERE id = ?
        """, (desc_id, asset_id))
        conn.commit()
    except Exception as exc:
        conn.rollback()
        raise exc
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Descrizione immagine via Ollama Vision
# ---------------------------------------------------------------------------
def describe_image(image_path: str) -> str:
    with open(image_path, 'rb') as f:
        img_b64 = base64.b64encode(f.read()).decode('utf-8')

    payload = json.dumps({
        "model": OLLAMA_MODEL,
        "prompt": IMAGE_PROMPT,
        "images": [img_b64],
        "stream": False,
    }).encode('utf-8')

    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/generate",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        result = json.loads(resp.read().decode('utf-8'))
        return result.get('response', '').strip()


# ---------------------------------------------------------------------------
# Descrizione video via generate_video_description.sh
# ---------------------------------------------------------------------------
def describe_video(video_path: str) -> str:
    if not os.path.isfile(VIDEO_DESC_SCRIPT):
        raise FileNotFoundError(f"Script non trovato: {VIDEO_DESC_SCRIPT}")

    result = subprocess.run(
        ['bash', VIDEO_DESC_SCRIPT, video_path],
        capture_output=True,
        text=True,
        timeout=600,
    )
    if result.returncode != 0:
        stderr = result.stderr.strip()
        raise RuntimeError(f"generate_video_description.sh fallito: {stderr}")

    return result.stdout.strip()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    if len(sys.argv) < 2:
        print("Uso: worker_ai.py <asset_id>", file=sys.stderr)
        sys.exit(1)

    try:
        asset_id = int(sys.argv[1])
    except ValueError:
        print(f"asset_id non valido: {sys.argv[1]}", file=sys.stderr)
        sys.exit(1)

    asset = fetch_asset(asset_id)
    if asset is None:
        print(f"[{asset_id}] Asset non trovato nel DB.", file=sys.stderr)
        sys.exit(0)

    if already_described(asset):
        print(f"[{asset_id}] Gia' descritto, salto.")
        sys.exit(0)

    media_kind = asset.get('media_kind', 'image')
    abs_path   = asset.get('absolute_path', '')
    thumb_rel  = asset.get('thumb_path', '')
    thumb_abs  = os.path.join(THUMB_DIR, thumb_rel) if thumb_rel else ''

    try:
        if media_kind == 'video':
            print(f"[{asset_id}] Descrizione VIDEO: {abs_path}")
            if not os.path.isfile(abs_path):
                print(f"[{asset_id}] File video non trovato: {abs_path}", file=sys.stderr)
                sys.exit(0)
            description = describe_video(abs_path)

        else:
            if thumb_abs and os.path.isfile(thumb_abs):
                img_for_ai = thumb_abs
            elif os.path.isfile(abs_path):
                img_for_ai = abs_path
            else:
                print(f"[{asset_id}] Nessuna immagine disponibile: {abs_path}", file=sys.stderr)
                sys.exit(0)

            print(f"[{asset_id}] Descrizione IMMAGINE: {img_for_ai}")
            description = describe_image(img_for_ai)

        if not description:
            print(f"[{asset_id}] Descrizione vuota, salto.", file=sys.stderr)
            sys.exit(0)

        save_description(asset_id, description)
        print(f"[{asset_id}] OK  -  {len(description)} caratteri.")

    except urllib.error.URLError as exc:
        print(f"[{asset_id}] Errore Ollama: {exc}", file=sys.stderr)
        sys.exit(1)
    except subprocess.TimeoutExpired:
        print(f"[{asset_id}] Timeout generazione descrizione video.", file=sys.stderr)
        sys.exit(1)
    except Exception as exc:
        print(f"[{asset_id}] Errore: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
