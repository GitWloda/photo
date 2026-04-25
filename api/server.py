#!/usr/bin/env python3
import json
import mimetypes
import os
import sqlite3
import sys
import urllib.parse
from datetime import datetime
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from lib.config import ROOT_DIR, load_env_into_os

load_env_into_os()

DB_PATH = os.environ.get("DB_PATH", os.path.join(ROOT_DIR, "db", "gallery.db"))
PHOTO_ROOT = os.environ.get("PHOTO_ROOT", os.path.expanduser("~/Pictures"))
THUMB_DIR = os.environ.get("THUMB_DIR", os.path.join(ROOT_DIR, "data", "thumbs"))
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8080"))

if not os.path.isabs(DB_PATH):
    DB_PATH = os.path.abspath(os.path.join(ROOT_DIR, DB_PATH))
PHOTO_ROOT = os.path.abspath(PHOTO_ROOT)
if not os.path.isabs(THUMB_DIR):
    THUMB_DIR = os.path.join(ROOT_DIR, THUMB_DIR)
THUMB_DIR = os.path.abspath(THUMB_DIR)

WHITE = "\033[97m"
YELLOW = "\033[33m"
RED = "\033[31m"
RESET = "\033[0m"


def _ts() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def log_run(msg):
    print(f"{WHITE}[{_ts()}] [RUN]  server: {msg}{RESET}", flush=True)


def log_warn(msg):
    print(f"{YELLOW}[{_ts()}] [WARN] server: {msg}{RESET}", flush=True)


def log_err(msg):
    print(f"{RED}[{_ts()}] [ERR]  server: {msg}{RESET}", file=sys.stderr, flush=True)


def get_db_connection():
    db_dir = os.path.dirname(DB_PATH)
    if db_dir and not os.path.isdir(db_dir):
        raise sqlite3.OperationalError(f"DB directory non trovata: {db_dir}")
    if not os.path.exists(DB_PATH):
        raise sqlite3.OperationalError(f"DB file non trovato: {DB_PATH}")

    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=15000")
    return conn


def _safe_path(base: str, rel: str):
    safe_rel = os.path.normpath(rel)
    full = os.path.abspath(os.path.join(base, safe_rel))
    if full != base and not full.startswith(base + os.sep):
        return None
    return full


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


class GalleryHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        try:
            status = int(args[1]) if len(args) >= 2 else None
            msg = "%s - - [%s] %s" % (
                self.address_string(),
                self.log_date_time_string(),
                format % args,
            )
            if status and status >= 500:
                log_err(msg)
            elif status and status >= 400:
                log_warn(msg)
            else:
                log_run(msg)
        except Exception:
            log_warn(f"log_message fallback: {format % args}")

    def _send_json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _handle_db_error(self, exc):
        log_err(str(exc))
        self._send_json({"error": str(exc), "db_path": DB_PATH}, status=500)

    def _send_file(self, path, content_type=None, status=200):
        if not os.path.isfile(path):
            log_warn(f"file non trovato: {path}")
            self.send_error(404, "File not found")
            return

        if content_type is None:
            content_type, _ = mimetypes.guess_type(path)
        if content_type is None:
            content_type = "application/octet-stream"

        try:
            file_size = os.path.getsize(path)
        except OSError:
            log_err(f"impossibile stat file: {path}")
            self.send_error(500, "Cannot stat file")
            return

        range_header = self.headers.get("Range")
        if range_header:
            try:
                unit, rng = range_header.strip().split("=", 1)
                if unit != "bytes":
                    raise ValueError("unsupported range unit")

                start_str, end_str = rng.split("-", 1)

                if start_str == "" and end_str == "":
                    raise ValueError("invalid empty range")

                if start_str == "":
                    suffix_len = int(end_str)
                    if suffix_len <= 0:
                        raise ValueError("invalid suffix length")
                    start = max(file_size - suffix_len, 0)
                    end = file_size - 1
                else:
                    start = int(start_str)
                    end = int(end_str) if end_str else file_size - 1

                if start < 0 or end < start or start >= file_size:
                    raise ValueError("range out of bounds")

                end = min(end, file_size - 1)
                length = end - start + 1

                self.send_response(206)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(length))
                self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
                self.send_header("Accept-Ranges", "bytes")
                self.end_headers()

                with open(path, "rb") as f:
                    f.seek(start)
                    remaining = length
                    chunk_size = 64 * 1024
                    while remaining > 0:
                        chunk = f.read(min(chunk_size, remaining))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
                return

            except Exception as exc:
                log_warn(f"Range non valido '{range_header}' su {path}: {exc}")
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{file_size}")
                self.end_headers()
                return

        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(file_size))
            self.send_header("Accept-Ranges", "bytes")
            self.end_headers()

            with open(path, "rb") as f:
                while True:
                    chunk = f.read(64 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except OSError:
            log_err(f"impossibile leggere file: {path}")
            if not self.wfile.closed:
                self.send_error(500, "Cannot read file")
        except BrokenPipeError:
            log_warn(f"client disconnected durante invio file: {path}")

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)
        log_run(f"GET {self.path}")

        if path in ("/", "/index.html"):
            return self._send_file(
                os.path.join(ROOT_DIR, "frontend", "index.html"),
                "text/html; charset=utf-8",
            )

        if path == "/app.js":
            return self._send_file(
                os.path.join(ROOT_DIR, "frontend", "app.js"),
                "application/javascript; charset=utf-8",
            )

        if path == "/styles.css":
            return self._send_file(
                os.path.join(ROOT_DIR, "frontend", "styles.css"),
                "text/css; charset=utf-8",
            )

        if path.startswith("/files/"):
            rel = urllib.parse.unquote(path[len("/files/"):])
            full = _safe_path(PHOTO_ROOT, rel)
            if full is None:
                log_warn(f"path traversal bloccato: {rel}")
                self.send_error(403, "Forbidden")
                return
            return self._send_file(full)

        if path.startswith("/thumbs/"):
            rel = urllib.parse.unquote(path[len("/thumbs/"):])
            full = _safe_path(THUMB_DIR, rel)
            if full is None:
                log_warn(f"path traversal bloccato (thumb): {rel}")
                self.send_error(403, "Forbidden")
                return
            return self._send_file(full)

        if path == "/media":
            return self.handle_media_list(query)

        if path.startswith("/media/"):
            parts = path.strip("/").split("/")
            if len(parts) == 2:
                return self.handle_media_detail(parts[1])

        if path == "/search":
            return self.handle_search(query)

        log_warn(f"route non trovata: {path}")
        self.send_error(404, "Not found")

    def handle_media_list(self, query):
        try:
            page = max(1, int(query.get("page", ["1"])[0]))
            limit = max(1, min(500, int(query.get("limit", ["100"])[0])))
        except ValueError:
            return self._send_json({"error": "page/limit non validi"}, status=400)

        offset = (page - 1) * limit

        try:
            conn = get_db_connection()
        except sqlite3.OperationalError as exc:
            return self._handle_db_error(exc)

        try:
            total = conn.execute("SELECT COUNT(*) AS cnt FROM assets").fetchone()["cnt"]

            rows = conn.execute(
                """
                SELECT assets.id AS asset_id,
                       assets.media_kind,
                       asset_files.filename,
                       asset_files.relative_path,
                       asset_files.thumb_path,
                       ai_descriptions.description
                FROM assets
                JOIN asset_files ON asset_files.asset_id = assets.id
                LEFT JOIN ai_descriptions ON ai_descriptions.id = assets.ai_description_id
                ORDER BY assets.created_at DESC
                LIMIT ? OFFSET ?
                """,
                (limit, offset),
            ).fetchall()
        finally:
            conn.close()

        items = []
        for r in rows:
            rel = urllib.parse.quote(r["relative_path"], safe="/")
            furl = f"/files/{rel}"
            turl = (
                f"/thumbs/{urllib.parse.quote(r['thumb_path'], safe='/')}"
                if r["thumb_path"]
                else furl
            )
            items.append(
                {
                    "id": r["asset_id"],
                    "media_kind": r["media_kind"] or "image",
                    "filename": r["filename"],
                    "file_url": furl,
                    "thumb_url": turl,
                    "description": r["description"] or "",
                }
            )

        self._send_json(
            {
                "items": items,
                "page": page,
                "limit": limit,
                "total": total,
                "has_more": offset + len(items) < total,
            }
        )

    def handle_media_detail(self, id_str):
        try:
            asset_id = int(id_str)
        except ValueError:
            self.send_error(400, "Invalid id")
            return

        try:
            conn = get_db_connection()
        except sqlite3.OperationalError as exc:
            return self._handle_db_error(exc)

        try:
            row = conn.execute(
                """
                SELECT assets.id AS asset_id,
                       assets.title,
                       assets.media_kind,
                       asset_files.filename,
                       asset_files.relative_path,
                       asset_files.absolute_path,
                       asset_files.sha256,
                       asset_files.metadata_json,
                       asset_files.size_bytes,
                       asset_files.mtime,
                       asset_files.thumb_path,
                       ai_descriptions.description,
                       ai_descriptions.model,
                       ai_descriptions.language,
                       ai_descriptions.created_at AS description_created_at
                FROM assets
                JOIN asset_files ON asset_files.asset_id = assets.id
                LEFT JOIN ai_descriptions ON ai_descriptions.id = assets.ai_description_id
                WHERE assets.id = ?
                """,
                (asset_id,),
            ).fetchone()
        finally:
            conn.close()

        if row is None:
            self.send_error(404, "Media not found")
            return

        rel = urllib.parse.quote(row["relative_path"], safe="/")
        furl = f"/files/{rel}"
        turl = (
            f"/thumbs/{urllib.parse.quote(row['thumb_path'], safe='/')}"
            if row["thumb_path"]
            else furl
        )

        try:
            metadata = json.loads(row["metadata_json"]) if row["metadata_json"] else {}
        except Exception:
            metadata = {}

        self._send_json(
            {
                "id": row["asset_id"],
                "title": row["title"],
                "media_kind": row["media_kind"] or "image",
                "filename": row["filename"],
                "file_url": furl,
                "thumb_url": turl,
                "absolute_path": row["absolute_path"],
                "sha256": row["sha256"],
                "metadata": metadata,
                "size_bytes": row["size_bytes"],
                "mtime": row["mtime"],
                "ai_description": {
                    "text": row["description"] or "",
                    "model": row["model"] or "",
                    "language": row["language"] or "",
                    "created_at": row["description_created_at"],
                },
            }
        )

    def handle_search(self, query):
        q = (query.get("q", [""])[0] or "").strip()
        if not q:
            return self.handle_media_list(query)

        try:
            page = max(1, int(query.get("page", ["1"])[0]))
            limit = max(1, min(500, int(query.get("limit", ["100"])[0])))
        except ValueError:
            return self._send_json({"error": "page/limit non validi"}, status=400)

        offset = (page - 1) * limit
        pattern = f"%{q}%"

        try:
            conn = get_db_connection()
        except sqlite3.OperationalError as exc:
            return self._handle_db_error(exc)

        try:
            total = conn.execute(
                """
                SELECT COUNT(DISTINCT assets.id) AS cnt
                FROM assets
                JOIN asset_files ON asset_files.asset_id = assets.id
                LEFT JOIN ai_descriptions ON ai_descriptions.id = assets.ai_description_id
                WHERE asset_files.filename LIKE ?
                   OR (ai_descriptions.description IS NOT NULL
                       AND ai_descriptions.description LIKE ?)
                """,
                (pattern, pattern),
            ).fetchone()["cnt"]

            rows = conn.execute(
                """
                SELECT DISTINCT
                       assets.id AS asset_id,
                       assets.media_kind,
                       asset_files.filename,
                       asset_files.relative_path,
                       asset_files.thumb_path,
                       ai_descriptions.description
                FROM assets
                JOIN asset_files ON asset_files.asset_id = assets.id
                LEFT JOIN ai_descriptions ON ai_descriptions.id = assets.ai_description_id
                WHERE asset_files.filename LIKE ?
                   OR (ai_descriptions.description IS NOT NULL
                       AND ai_descriptions.description LIKE ?)
                ORDER BY assets.created_at DESC
                LIMIT ? OFFSET ?
                """,
                (pattern, pattern, limit, offset),
            ).fetchall()
        finally:
            conn.close()

        items = []
        for r in rows:
            rel = urllib.parse.quote(r["relative_path"], safe="/")
            furl = f"/files/{rel}"
            turl = (
                f"/thumbs/{urllib.parse.quote(r['thumb_path'], safe='/')}"
                if r["thumb_path"]
                else furl
            )
            items.append(
                {
                    "id": r["asset_id"],
                    "media_kind": r["media_kind"] or "image",
                    "filename": r["filename"],
                    "file_url": furl,
                    "thumb_url": turl,
                    "description": r["description"] or "",
                }
            )

        self._send_json(
            {
                "items": items,
                "page": page,
                "limit": limit,
                "total": total,
                "has_more": offset + len(items) < total,
                "query": q,
            }
        )


def run():
    log_run(f"ROOT_DIR={ROOT_DIR}")
    log_run(f"DB_PATH={DB_PATH} exists={os.path.exists(DB_PATH)}")
    log_run(f"PHOTO_ROOT={PHOTO_ROOT}")
    log_run(f"THUMB_DIR={THUMB_DIR}")
    server = ThreadedHTTPServer((HOST, PORT), GalleryHandler)
    log_run(f"Server in ascolto su http://{HOST}:{PORT}")
    log_run("Ctrl+C per interrompere.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log_warn("Arresto server richiesto da tastiera.")
    finally:
        server.server_close()
        log_run("Server chiuso.")


if __name__ == "__main__":
    run()