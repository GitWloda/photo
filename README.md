# Photo Gallery AI (Locale)

Gallery fotografica locale con descrizioni AI generate via Ollama.
Scansiona automaticamente una directory di foto/video, genera thumbnail,
estrae metadati EXIF e produce descrizioni in linguaggio naturale.

## Requisiti di sistema

| Tool           | Versione minima | Uso                          |
|----------------|-----------------|------------------------------|
| Python         | 3.9+            | API server e worker AI       |
| SQLite         | 3.35+           | Database (incluso in Python) |
| ffmpeg         | 4.x+            | Thumbnail da video           |
| ImageMagick    | 7.x+            | Thumbnail da immagini        |
| ExifTool       | 12.x+           | Estrazione metadati EXIF     |
| GNU parallel   | 20.x+           | Parallelizzazione worker     |
| Ollama         | 0.3+            | Inference AI locale          |

## Installazione rapida (Arch/Manjaro)
\`\`\`bash
sudo pacman -S ffmpeg imagemagick perl-image-exiftool \
               parallel ollama python
\`\`\`

## Installazione rapida (Ubuntu/Debian)
\`\`\`bash
sudo apt install ffmpeg imagemagick libimage-exiftool-perl \
                 parallel python3
# Ollama: curl -fsSL https://ollama.com/install.sh | sh
\`\`\`

## Configurazione

Copia e modifica il file di configurazione:
\`\`\`bash
cp config/app.env.example config/app.env   # se esiste
# oppure modifica direttamente config/app.env
\`\`\`

### Variabili disponibili

| Variabile       | Default                  | Descrizione                              |
|-----------------|--------------------------|------------------------------------------|
| `PHOTO_ROOT`    | `~/Pictures`             | Directory radice delle foto da scansionare |
| `DB_PATH`       | `db/gallery.db`          | Percorso del database SQLite             |
| `LOG_FILE`      | `logs/app.log`           | File di log                              |
| `THUMB_DIR`     | `data/thumbs`            | Directory thumbnail generati             |
| `HOST`          | `127.0.0.1`              | Indirizzo di ascolto del server          |
| `PORT`          | `8080`                   | Porta del server                         |
| `OLLAMA_MODEL`  | `gemma3:12b`             | Modello Ollama per le descrizioni        |
| `LANGUAGE`      | `italiano`               | Lingua delle descrizioni AI              |
| `AI_WORKERS`    | `4`                      | Worker paralleli per l'AI                |
| `SCAN_WORKERS`  | `nproc`                  | Worker paralleli per la scansione file   |
| `DESC_RETRIES`  | `3`                      | Tentativi in caso di errore Ollama       |
| `DESC_SLEEP`    | `1.5`                    | Pausa (secondi) tra tentativi            |

## Primo avvio

\`\`\`bash
# 1. Inizializza il database
bash init_db.sh

# 2. Scansiona le foto e genera descrizioni AI
bash bin/update_db.sh

# 3. Avvia il server
python3 api/server.py

# 4. Apri nel browser
xdg-open http://127.0.0.1:8080
\`\`\`

## API REST

| Endpoint              | Descrizione                                      |
|-----------------------|--------------------------------------------------|
| `GET /media?page=&limit=` | Lista paginata degli asset                  |
| `GET /media/{id}`     | Dettaglio singolo asset                          |
| `GET /search?q=&page=` | Ricerca per nome file o descrizione AI          |
| `GET /files/{path}`   | File originale                                   |
| `GET /thumbs/{path}`  | Thumbnail                                        |

## Struttura del progetto

\`\`\`
photo/
├── api/           # Server HTTP Python
├── bin/           # Script Bash e worker Python AI
├── config/        # Configurazione (app.env)
├── db/            # Database SQLite
├── docs/          # Documentazione aggiuntiva
├── frontend/      # HTML/CSS/JS della gallery
├── lib/           # Moduli Python condivisi
├── logs/          # Log di runtime
├── migrations/    # Migrazioni schema DB
└── schema.sql     # Schema del database
\`\`\`