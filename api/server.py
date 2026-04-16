#!/usr/bin/env python3
import json
import mimetypes
import os
import sqlite3
import urllib.parse
from datetime import datetime
from http.server import HTTPServer, BaseHTTPRequestHandler

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DB_PATH = os.environ.get("DB_PATH", os.path.join(ROOT_DIR, "db", "gallery.db"))
PHOTO_ROOT = os.environ.get("PHOTO_ROOT", os.path.expanduser("~/Pictures"))
THUMB_DIR = os.environ.get("THUMB_DIR", os.path.join(ROOT_DIR, "data", "thumbs"))
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8080"))

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

def log_run(msg: str) -> None:
    print(f"{WHITE}[{_ts()}] [RUN]  server: {msg}{RESET}", flush=True)

def log_warn(msg: str) -> None:
    print(f"{YELLOW}[{_ts()}] [WARN] server: {msg}{RESET}", flush=True)

def log_err(msg: str) -> None:
    print(f"{RED}[{_ts()}] [ERR]  server: {msg}{RESET}", file=sys.stderr, flush=True)

def get_db_connection():
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=15000")
    return conn

class GalleryHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        try:
            status = None
            if len(args) >= 2:
                status = int(args[1])
            message = "%s - - [%s] %s" % (self.address_string(), self.log_date_time_string(), format % args)
            if status is not None and status >= 500:
                log_err(message)
            elif status is not None and status >= 400:
                log_warn(message)
            else:
                log_run(message)
        except Exception:
            log_warn(f"log_message fallback: {format % args}")

    def _send_json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

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
            with open(path, "rb") as f:
                data = f.read()
        except OSError:
            log_err(f"impossibile leggere file: {path}")
            self.send_error(500, "Cannot read file")
            return
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)
        log_run(f"GET {self.path}")

        if path == "/" or path == "/index.html":
            index_path = os.path.join(ROOT_DIR, "frontend", "index.html")
            return self._send_file(index_path, "text/html; charset=utf-8")

        if path == "/app.js":
            js_path = os.path.join(ROOT_DIR, "frontend", "app.js")
            return self._send_file(js_path, "application/javascript; charset=utf-8")

        if path == "/styles.css":
            css_path = os.path.join(ROOT_DIR, "frontend", "styles.css")
            return self._send_file(css_path, "text/css; charset=utf-8")

        if path.startswith("/files/"):
            rel = urllib.parse.unquote(path[len("/files/"):])
            safe_rel = os.path.normpath(rel)
            file_path = os.path.abspath(os.path.join(PHOTO_ROOT, safe_rel))
            if not file_path.startswith(PHOTO_ROOT):
                log_warn(f"tentativo accesso forbidden a file: {file_path}")
                self.send_error(403, "Forbidden")
                return
            return self._send_file(file_path)

        if path.startswith("/thumbs/"):
            rel = urllib.parse.unquote(path[len("/thumbs/"):])
            safe_rel = os.path.normpath(rel)
            file_path = os.path.abspath(os.path.join(THUMB_DIR, safe_rel))
            if not file_path.startswith(THUMB_DIR):
                log_warn(f"tentativo accesso forbidden a thumb: {file_path}")
                self.send_error(403, "Forbidden")
                return
            return self._send_file(file_path)

        if path == "/media":
            return self.handle_media_list()

        if path.startswith("/media/"):
            parts = path.strip("/").split("/")
            if len(parts) == 2 and parts[0] == "media":
                return self.handle_media_detail(parts[1])

        if path == "/search":
            q = query.get("q", [""])[0]
            return self.handle_search(q)

        log_warn(f"route non trovata: {path}")
        self.send_error(404, "Not found")

    def handle_media_list(self):
        conn = get_db_connection()
        try:
            cur = conn.cursor()
            cur.execute(
                """
                SELECT assets.id AS asset_id,
                       asset_files.filename,
                       asset_files.relative_path,
                       asset_files.thumb_path,
                       ai_descriptions.description
                FROM assets
                JOIN asset_files ON asset_files.asset_id = assets.id
                LEFT JOIN ai_descriptions ON ai_descriptions.id = assets.ai_description_id
                ORDER BY assets.created_at DESC;
                """
            )
            rows = cur.fetchall()
        finally:
            conn.close()
        items = []
        for r in rows:
            rel_path = urllib.parse.quote(r["relative_path"], safe="/")
            thumb_path = r["thumb_path"]
            file_url = f"/files/{rel_path}"
            thumb_url = f"/thumbs/{urllib.parse.quote(thumb_path, safe='/')}" if thumb_path else file_url
            items.append({
                "id": r["asset_id"],
                "filename": r["filename"],
                "file_url": file_url,
                "thumb_url": thumb_url,
                "description": r["description"] or "",
            })
        return self._send_json(items)

    def handle_media_detail(self, id_str):
        try:
            asset_id = int(id_str)
        except ValueError:
            log_warn(f"id non valido: {id_str}")
            self.send_error(400, "Invalid id")
            return
        conn = get_db_connection()
        try:
            cur = conn.cursor()
            cur.execute(
                """
                SELECT assets.id AS asset_id,
                       assets.title,
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
                WHERE assets.id = ?;
                """,
                (asset_id,),
            )
            row = cur.fetchone()
        finally:
            conn.close()
        if row is None:
            log_warn(f"media non trovato: asset_id={asset_id}")
            self.send_error(404, "Media not found")
            return
        rel_path = urllib.parse.quote(row["relative_path"], safe="/")
        thumb_path = row["thumb_path"]
        file_url = f"/files/{rel_path}"
        thumb_url = f"/thumbs/{urllib.parse.quote(thumb_path, safe='/')}" if thumb_path else file_url
        try:
            metadata = json.loads(row["metadata_json"]) if row["metadata_json"] else {}
        except Exception:
            log_warn(f"metadata_json non valido per asset_id={asset_id}")
            metadata = {}
        result = {
            "id": row["asset_id"],
            "title": row["title"],
            "filename": row["filename"],
            "file_url": file_url,
            "thumb_url": thumb_url,
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
        self._send_json(result)

    def handle_search(self, query_str):
        q = (query_str or "").strip()
        if not q:
            return self.handle_media_list()
        pattern = f"%{q}%"
        conn = get_db_connection()
        try:
            cur = conn.cursor()
            cur.execute(
                """
                SELECT DISTINCT assets.id AS asset_id,
                       asset_files.filename,
                       asset_files.relative_path,
                       asset_files.thumb_path,
                       ai_descriptions.description
                FROM assets
                JOIN asset_files ON asset_files.asset_id = assets.id
                LEFT JOIN ai_descriptions ON ai_descriptions.asset_id = assets.id
                WHERE asset_files.filename LIKE ?
                   OR (ai_descriptions.description IS NOT NULL AND ai_descriptions.description LIKE ?)
                ORDER BY assets.created_at DESC;
                """,
                (pattern, pattern),
            )
            rows = cur.fetchall()
        finally:
            conn.close()
        items = []
        for r in rows:
            rel_path = urllib.parse.quote(r["relative_path"], safe="/")
            thumb_path = r["thumb_path"]
            file_url = f"/files/{rel_path}"
            thumb_url = f"/thumbs/{urllib.parse.quote(thumb_path, safe='/')}" if thumb_path else file_url
            items.append({
                "id": r["asset_id"],
                "filename": r["filename"],
                "file_url": file_url,
                "thumb_url": thumb_url,
                "description": r["description"] or "",
            })
        return self._send_json(items)

def run():
    server = HTTPServer((HOST, PORT), GalleryHandler)
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