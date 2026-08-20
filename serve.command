#!/bin/bash
# Double-click to launch the T-Display-S3 Media Uploader on a local server.
# Serving over http://localhost is the most reliable context for Web Serial.
cd "$(dirname "$0")" || exit 1
PORT=8123
echo "Serving T-Display-S3 Media Uploader at http://localhost:$PORT"
echo "Opening browser… (use Chrome or Edge for flashing)"
( sleep 1; open -a "Google Chrome" "http://localhost:$PORT/lilygoDisplay.html" 2>/dev/null \
    || open "http://localhost:$PORT/lilygoDisplay.html" ) &
exec python3 -m http.server "$PORT"
