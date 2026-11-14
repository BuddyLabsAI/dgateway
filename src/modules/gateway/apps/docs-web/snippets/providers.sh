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


admin /admin/api/providers
provider=$(admin /admin/api/providers -X POST -d '{"name":"docs-example","kind":"mock","base_url":"","path":"","wire":"map","enabled":true,"timeout_ms":1000,"limits":{"max_questions":400,"max_choices":64},"extra_body":{},"key":{"source":"none"}}')
printf '%s\n' "$provider"
provider_id=$(printf '%s' "$provider" | bun -e 'console.log((await Bun.stdin.json()).id)')
admin "/admin/api/providers/$provider_id/models"
admin "/admin/api/providers/$provider_id/test" -X POST -d '{"model":"mock-1"}'
admin "/admin/api/providers/$provider_id" -X PATCH -d '{"enabled":false}'
admin "/admin/api/providers/$provider_id" -X DELETE
