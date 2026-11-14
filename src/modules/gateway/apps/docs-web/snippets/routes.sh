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


providers=$(admin /admin/api/providers)
mock_id=$(printf '%s' "$providers" | bun -e 'console.log((await Bun.stdin.json()).find(p => p.kind === "mock").id)')
admin /admin/api/routes
route=$(admin /admin/api/routes -X POST -d "{\"alias\":\"docs-example\",\"description\":\"Documentation example\",\"enabled\":true,\"targets\":[{\"provider_id\":\"$mock_id\",\"model\":\"mock-1\",\"timeout_ms\":1000,\"price_per_m_input\":null}]}")
printf '%s\n' "$route"
route_id=$(printf '%s' "$route" | bun -e 'console.log((await Bun.stdin.json()).id)')
admin "/admin/api/routes/$route_id" -X PATCH -d '{"description":"Updated documentation example"}'
admin "/admin/api/routes/$route_id" -X DELETE
