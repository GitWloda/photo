PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS assets (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    title           TEXT NOT NULL,
    ai_description_id INTEGER,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    FOREIGN KEY (ai_description_id) REFERENCES ai_descriptions(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS asset_files (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id        INTEGER NOT NULL,
    absolute_path   TEXT NOT NULL UNIQUE,
    relative_path   TEXT NOT NULL,
    filename        TEXT NOT NULL,
    sha256          TEXT NOT NULL,
    metadata_json   TEXT,
    size_bytes      INTEGER,
    mtime           INTEGER,
    thumb_path      TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ai_descriptions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id        INTEGER NOT NULL,
    model           TEXT NOT NULL,
    language        TEXT,
    description     TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_asset_files_path ON asset_files(absolute_path);
CREATE INDEX IF NOT EXISTS idx_asset_files_sha ON asset_files(sha256);
CREATE INDEX IF NOT EXISTS idx_ai_desc_asset ON ai_descriptions(asset_id);
CREATE INDEX IF NOT EXISTS idx_assets_created_at ON assets(created_at);

/* ─── CESTINO ───────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS trash (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    original_asset_id       INTEGER,
    original_asset_file_id  INTEGER,
    asset_title             TEXT,
    filename                TEXT NOT NULL,
    original_absolute_path  TEXT NOT NULL,
    original_relative_path  TEXT NOT NULL,
    trash_relative_path     TEXT NOT NULL,
    sha256                  TEXT,
    size_bytes              INTEGER,
    mtime                   INTEGER,
    thumb_path              TEXT,
    metadata_json           TEXT,
    media_kind              TEXT DEFAULT 'image',
    trashed_at              INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trash_sha ON trash(sha256);
CREATE INDEX IF NOT EXISTS idx_trash_at  ON trash(trashed_at DESC);