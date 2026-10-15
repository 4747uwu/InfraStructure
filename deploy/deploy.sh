#!/usr/bin/env bash
# Runs on the server, inside the stack folder, after the Deploy workflow has uploaded
# docker-compose.yml, Caddyfile, accounts.env, app.env and .env.next.
#
# Switches the stack to the given image and waits for it to report healthy. If it
# does not, the previous image is started again and the script exits non-zero so
# the workflow run fails visibly.
set -euo pipefail

tag="${1:?usage: deploy.sh <image-tag>}"

docker compose version >/dev/null 2>&1 || {
  echo "Docker with the compose plugin is not installed for this user." >&2
  exit 1
}

previous="$(sed -n 's/^IMAGE_TAG=//p' .env 2>/dev/null || true)"
mv -f .env.next .env

echo "==> Deploying ${tag} (running before: ${previous:-nothing})"
docker compose pull --quiet

if docker compose up -d --wait --wait-timeout 180; then
  docker compose ps
  echo "==> ${tag} is healthy."
  exit 0
fi

echo "==> ${tag} did not become healthy. Last app output:" >&2
docker compose logs --tail 60 app >&2 || true

if [ -n "$previous" ] && [ "$previous" != "$tag" ]; then
  echo "==> Rolling back to ${previous}" >&2
  sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=${previous}|" .env
  if docker compose up -d --wait --wait-timeout 180; then
    echo "==> Rolled back. ${previous} is serving again." >&2
  else
    echo "==> The rollback did not become healthy either. The server needs attention." >&2
  fi
fi
exit 1
