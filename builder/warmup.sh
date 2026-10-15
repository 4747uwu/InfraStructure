#!/usr/bin/env bash
# Image-build-time rehearsal: the same steps worker.mjs runs for a real job.
set -euo pipefail

WARM=/tmp/warm
mkdir -p "$WARM"
tar -C /template --exclude=./node_modules -cf - . | tar -C "$WARM" -xf -
ln -s /template/node_modules "$WARM/node_modules"
cd "$WARM"

node tools/customize.js /builder/warmup-spec.json

GOOS=windows GOARCH=386 CGO_ENABLED=0 go build -ldflags "-X main.version=1.0.0 -s -w" -o tarang-sender.exe ./cmd/tarang-sender/
go version tarang-sender.exe | tee /dev/stderr | grep -q 'go1\.20\.'

npx --no-install electron-builder --win --ia32 --publish never
ls -la dist/*.exe
test -f "dist/Warmup Router Setup 1.0.0.exe"

cd /
rm -rf "$WARM"
echo "warm-up build OK"
