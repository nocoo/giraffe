#!/bin/sh
set -e
cd "$(dirname "$0")/.."
mkdir -p public
sips -s format png -z 24 24 logo.png --out public/logo-24.png >/dev/null
sips -s format png -z 32 32 logo.png --out public/logo-32.png >/dev/null
sips -s format png -z 180 180 logo.png --out public/apple-touch-icon.png >/dev/null
