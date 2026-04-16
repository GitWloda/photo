find . -type f -exec chmod +x {} \;

./bin/scan_library.sh

clear && set -a && source photo/config/app.env && set +a && python3 photo/api/server.py
