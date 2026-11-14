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


client=$(admin /admin/api/clients -X POST -d '{"name":"Documentation example"}')
printf '%s\n' "$client"
client_id=$(printf '%s' "$client" | bun -e 'console.log((await Bun.stdin.json()).id)')
admin /admin/api/clients
admin "/admin/api/clients/$client_id" -X DELETE
settings=$(admin /admin/api/settings)
printf '%s\n' "$settings"
default_route=$(printf '%s' "$settings" | bun -e 'console.log(JSON.stringify((await Bun.stdin.json()).default_route))')
admin /admin/api/settings -X PATCH -d "{\"default_route\":$default_route}"
