# Pipeline Video — Come Funziona

## Flusso completo (integrato nella repo esistente)

```
update_db.sh
│
├── Scansiona PHOTO_ROOT (immagini + video, estensioni da app.env)
│
├── Per ogni FILE NUOVO o MODIFICATO:
│   ├── [immagine]  → genera thumbnail via ImageMagick
│   └── [video]     → estrae frame centrale via ffmpeg → thumbnail
│
└── FASE IA (parallel, AI_WORKERS job)
    │
    ├── [immagine]  → worker_ai.py → Ollama Vision → salva in ai_descriptions
    │
    └── [video]     → worker_ai.py → generate_video_description.sh
                      │
                      ├── 1. Estrae VIDEO_FRAMES frame equidistanti (ffmpeg)
                      ├── 2. Applica frame_cleaner (rimuove neri/bianchi/simili)
                      ├── 3. Descrive ogni frame superstite (Ollama Vision)
                      └── 4. Sintetizza in un'unica descrizione (Ollama text)
                             → salva in ai_descriptions
```

## File modificati / aggiunti

| File | Stato | Cosa fa |
|------|-------|---------|
| `bin/update_db.sh` | **modifica** | Scansiona anche video; genera thumb via ffmpeg; scrive `media_kind` nel DB |
| `bin/worker_ai.py` | **modifica** | Dispatcha verso `describe_image` o `describe_video` in base a `media_kind` |
| `bin/generate_video_description.sh` | **nuovo** | Estrae frame, chiama frame_cleaner, descrive ogni frame, sintetizza |
| `db/schema.sql` | **modifica** | Aggiunge colonna `media_kind TEXT NOT NULL DEFAULT 'image'` ad `assets` |
| `db/migrate_add_media_kind.sh` | **nuovo** | Migrazione idempotente per DB gia' esistenti |
| `config/app.env` | **aggiunta righe** | `SUPPORTED_IMAGE_EXT`, `SUPPORTED_VIDEO_EXT`, `VIDEO_FRAMES`, `FRAME_CLEANER_ENABLED` |

## Prima esecuzione su DB esistente

```bash
# 1. Migra il DB esistente (aggiunge colonna media_kind)
bash db/migrate_add_media_kind.sh

# 2. Lancia la scansione completa come sempre
bash bin/update_db.sh
```

## Dipendenze richieste

| Tool | Uso | Installazione |
|------|-----|---|
| `ffmpeg` + `ffprobe` | Estrazione frame e thumbnail video | `sudo apt install ffmpeg` |
| `jq` | Parsing JSON in generate_video_description.sh | `sudo apt install jq` |
| `curl` | Chiamate Ollama REST | gia' presente di solito |
| Ollama con modello vision | Descrizione frame | es. `ollama pull llava` |

## Parametri chiave in `config/app.env`

| Variabile | Default | Descrizione |
|-----------|---------|-------------|
| `VIDEO_FRAMES` | `8` | Frame da analizzare per video |
| `FRAME_CLEANER_ENABLED` | `1` | Usa frame_cleaner per filtrare frame scadenti |
| `SUPPORTED_VIDEO_EXT` | `mp4,mov,m4v,avi,webm,mkv,mts,m2ts` | Estensioni video riconosciute |
| `LANGUAGE` | `italiano` | Lingua delle descrizioni AI (valido per foto e video) |
