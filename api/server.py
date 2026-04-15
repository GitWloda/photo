#!/usr/bin/env python3
import json
import mimetypes
import os
import sqlite3
import urllib.parse
from http.server import HTTPServer, BaseHTTPRequestHandler

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

# Config da variabili d'ambiente (impostate sorgendo config/app.env)
DB_PATH = os.environ.get("DB_PATH", os.path.join(ROOT_DIR, "db", "gallery.db"))
PHOTO_ROOT = os.environ.get("PHOTO_ROOT", os.path.expanduser("~/Pictures"))
THUMB_DIR = os.environ.get("THUMB_DIR", os.path.join(ROOT_DIR, "data", "thumbs"))
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8080"))

PHOTO_ROOT = os.path.abspath(PHOTO_ROOT)
if not os.path.isabs(THUMB_DIR):
    THUMB_DIR = os.path.join(ROOT_DIR, THUMB_DIR)
THUMB_DIR = os.path.abspath(THUMB_DIR)


def get_db_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


class GalleryHandler(BaseHTTPRequestHandler):
    def _send_json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_file(self, path, content_type=None, status=200):
        if not os.path.isfile(path):
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
            rel = path[len("/files/") :]
            safe_rel = os.path.normpath(rel)
            file_path = os.path.abspath(os.path.join(PHOTO_ROOT, safe_rel))
            if not file_path.startswith(PHOTO_ROOT):
                self.send_error(403, "Forbidden")
                return
            return self._send_file(file_path)

        if path.startswith("/thumbs/"):
            rel = path[len("/thumbs/") :]
            safe_rel = os.path.normpath(rel)
            file_path = os.path.abspath(os.path.join(THUMB_DIR, safe_rel))
            if not file_path.startswith(THUMB_DIR):
                self.send_error(403, "Forbidden")
                return
            return self._send_file(file_path)

        if path == "/media":
            return self.handle_media_list()

        if path.startswith("/media/"):
            # /media/{id}
            parts = path.strip("/").split("/")
            if len(parts) == 2 and parts[0] == "media":
                return self.handle_media_detail(parts[1])

        if path == "/search":
            q = query.get("q", [""])[0]
            return self.handle_search(q)

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
            rel_path = r["relative_path"]
            thumb_path = r["thumb_path"]
            file_url = f"/files/{rel_path}"
            if thumb_path:
                thumb_url = f"/thumbs/{thumb_path}"
            else:
                thumb_url = file_url
            items.append(
                {
                    "id": r["asset_id"],
                    "filename": r["filename"],
                    "file_url": file_url,
                    "thumb_url": thumb_url,
                    "description": r["description"] or "",
                }
            )
        self._send_json(items)

    def handle_media_detail(self, id_str):
        try:
            asset_id = int(id_str)
        except ValueError:
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
            self.send_error(404, "Media not found")
            return

        rel_path = row["relative_path"]
        thumb_path = row["thumb_path"]
        file_url = f"/files/{rel_path}"
        if thumb_path:
            thumb_url = f"/thumbs/{thumb_path}"
        else:
            thumb_url = file_url

        try:
            metadata = json.loads(row["metadata_json"]) if row["metadata_json"] else {}
        except Exception:
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
            rel_path = r["relative_path"]
            thumb_path = r["thumb_path"]
            file_url = f"/files/{rel_path}"
            if thumb_path:
                thumb_url = f"/thumbs/{thumb_path}"
            else:
                thumb_url = file_url
            items.append(
                {
                    "id": r["asset_id"],
                    "filename": r["filename"],
                    "file_url": file_url,
                    "thumb_url": thumb_url,
                    "description": r["description"] or "",
                }
            )
        self._send_json(items)


def run():
    server = HTTPServer((HOST, PORT), GalleryHandler)
    print(f"Server in ascolto su http://{HOST}:{PORT}")
    print("Ctrl+C per interrompere.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nArresto server...")
    finally:
        server.server_close()


if __name__ == "__main__":
    run()