#!/usr/bin/env python3
import json
import mimetypes
import os
import re
import sqlite3
import sys
import urllib.parse
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
ENV_FILE = os.path.join(ROOT_DIR, "config", "app.env")


def load_env_file(path: str) -> None:
    if not os.path.isfile(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ[key.strip()] = value.strip().strip('"').strip("'")


load_env_file(ENV_FILE)

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
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):
        try:
            status = int(args[1]) if len(args) >= 2 else None
            msg = "%s - - [%s] %s" % (
                self.address_string(), self.log_date_time_string(), format % args
            )
            if status and status >= 500:
                log_err(msg)
            elif status and status >= 400:
                log_warn(msg)
            else:
                log_run(msg)
        except Exception:
            log_warn(f"log_message fallback: {format % args}")

    def _write_safely(self, data: bytes) -> bool:
        try:
            self.wfile.write(data)
            return True
        except (BrokenPipeError, ConnectionResetError, OSError):
            return False

    def _send_json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self._write_safely(data)
        except (BrokenPipeError, ConnectionResetError, OSError):
            return

    def _handle_db_error(self, exc):
        log_err(str(exc))
        self._send_json({"error": str(exc), "db_path": DB_PATH}, status=500)

    def _parse_range_header(self, range_header: str, file_size: int):
        if not range_header or not range_header.startswith("bytes="):
            return None

        m = re.match(r"bytes=(\d*)-(\d*)$", range_header.strip())
        if not m:
            return "invalid"

        start_s, end_s = m.groups()

        if start_s == "" and end_s == "":
            return "invalid"

        if start_s == "":
            suffix_len = int(end_s)
            if suffix_len <= 0:
                return "invalid"
            if suffix_len > file_size:
                suffix_len = file_size
            start = file_size - suffix_len
            end = file_size - 1
            return (start, end)

        start = int(start_s)

        if start >= file_size:
            return "invalid"

        if end_s == "":
            end = file_size - 1
        else:
            end = int(end_s)
            if end < start:
                return "invalid"
            if end >= file_size:
                end = file_size - 1

        return (start, end)

    def _send_file(self, path, content_type=None):
        if not os.path.isfile(path):
            log_warn(f"file non trovato: {path}")
            try:
                self.send_error(404, "File not found")
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            return

        if content_type is None:
            content_type, _ = mimetypes.guess_type(path)
        if content_type is None:
            content_type = "application/octet-stream"

        try:
            file_size = os.path.getsize(path)
        except OSError:
            log_err(f"impossibile leggere size file: {path}")
            try:
                self.send_error(500, "Cannot stat file")
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            return

        range_header = self.headers.get("Range")
        byte_range = self._parse_range_header(range_header, file_size)

        if byte_range == "invalid":
            log_warn(f"Range non valido '{range_header}' su {path}")
            try:
                self.send_response(416, "Requested Range Not Satisfiable")
                self.send_header("Content-Range", f"bytes */{file_size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            return

        if byte_range is None:
            start = 0
            end = file_size - 1
            status = 200
        else:
            start, end = byte_range
            status = 206

        content_length = end - start + 1

        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(content_length))
            if status == 206:
                self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
            self.end_headers()
        except (BrokenPipeError, ConnectionResetError, OSError):
            return

        try:
            with open(path, "rb") as f:
                f.seek(start)
                remaining = content_length
                chunk_size = 64 * 1024

                while remaining > 0:
                    chunk = f.read(min(chunk_size, remaining))
                    if not chunk:
                        break
                    if not self._write_safely(chunk):
                        return
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            return
        except OSError as exc:
            log_warn(f"Errore I/O durante stream di {path}: {exc}")
            return

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
                try:
                    self.send_error(403, "Forbidden")
                except (BrokenPipeError, ConnectionResetError, OSError):
                    pass
                return
            return self._send_file(full)

        if path.startswith("/thumbs/"):
            rel = urllib.parse.unquote(path[len("/thumbs/"):])
            full = _safe_path(THUMB_DIR, rel)
            if full is None:
                log_warn(f"path traversal bloccato (thumb): {rel}")
                try:
                    self.send_error(403, "Forbidden")
                except (BrokenPipeError, ConnectionResetError, OSError):
                    pass
                return
            return self._send_file(full)

        if path == "/media":
            return self.handle_media_list(query)

        if path.startswith("/media/"):
            parts = path.strip("/").split("/")
            if len(parts) == 2:
                return self.handle_media_detail(parts[1])

        if path == "/search":
            return self.handle_search(query.get("q", [""])[0])

        log_warn(f"route non trovata: {path}")
        try:
            self.send_error(404, "Not found")
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def handle_media_list(self, query):
        try:
            page = max(1, int(query.get("page", ["1"])[0]))
        except ValueError:
            page = 1

        try:
            limit = int(query.get("limit", ["100"])[0])
        except ValueError:
            limit = 100

        limit = max(1, min(limit, 500))
        offset = (page - 1) * limit

        try:
            conn = get_db_connection()
        except sqlite3.OperationalError as exc:
            return self._handle_db_error(exc)

        try:
            total = conn.execute("SELECT COUNT(*) AS c FROM assets").fetchone()["c"]
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
                "page": page,
                "limit": limit,
                "total": total,
                "items": items,
            }
        )

    def handle_media_detail(self, id_str):
        try:
            asset_id = int(id_str)
        except ValueError:
            try:
                self.send_error(400, "Invalid id")
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
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
            try:
                self.send_error(404, "Media not found")
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
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
                "sha256": row["sha256"],
                "metadata": metadata,
                "size_bytes": row["size_bytes"],
                "mtime": row["mtime"],
                "description": row["description"] or "",
                "model": row["model"],
                "language": row["language"],
                "description_created_at": row["description_created_at"],
            }
        )

    def handle_search(self, q):
        q = (q or "").strip()
        if not q:
            return self._send_json({"query": "", "items": []})

        pattern = f"%{q}%"

        try:
            conn = get_db_connection()
        except sqlite3.OperationalError as exc:
            return self._handle_db_error(exc)

        try:
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
                WHERE asset_files.filename LIKE ?
                   OR ai_descriptions.description LIKE ?
                ORDER BY assets.created_at DESC
                LIMIT 100
                """,
                (pattern, pattern),
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

        self._send_json({"query": q, "items": items})


def main():
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
        log_warn("Interrotto da tastiera.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()