#!/bin/sh
set -eu

base_url=${BASE_URL:-http://127.0.0.1:8790}
curl --fail-with-body --silent --show-error --max-time 10 "$base_url/v1/models" \
  -H "Authorization: Bearer ${CLIENT_KEY:-}" -w '\n'
curl --fail-with-body --silent --show-error --max-time 10 "$base_url/healthz" -w '\n'
