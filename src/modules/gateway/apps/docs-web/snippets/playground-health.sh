#!/bin/sh
set -eu

base_url=${BASE_URL:-http://127.0.0.1:8790}
: "${ADMIN_TOKEN:?Set ADMIN_TOKEN to the gateway admin token}"

admin() {
  endpoint=$1
  shift
  curl --fail-with-body --silent --show-error --max-time 10 "$base_url$endpoint" \
    -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -w '\n' "$@"
}


admin /admin/api/playground -X POST -d '{"request":{"model":"default","input":"Hello","questions":[{"name":"greeting","type":"predicate","instructions":"Is this a greeting?"}]}}'
admin /admin/api/playground -X POST -d '{"request":{"model":"docs-missing-route","input":"Hello","questions":[{"name":"greeting","type":"predicate","instructions":"Is this a greeting?"}]}}'
admin /admin/api/health
