#!/bin/bash
# Start the vibes backend and patch Caddy to route to it.
# Idempotent — safe to run multiple times. Run after container restarts.

set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-8787}"

# 1. Start the backend if not running
if ! pgrep -f "bun run $HERE/server.ts" > /dev/null; then
  mkdir -p "$HERE/logs"
  nohup bun run "$HERE/server.ts" > "$HERE/logs/server.log" 2>&1 &
  disown
  sleep 1
  echo "started backend (pid=$!) on :$PORT"
else
  echo "backend already running"
fi

# 2. Patch Caddy admin API to add /vibes-api/* and /relations/* routes
ROUTE_JSON=$(cat <<EOF
{
  "match": [{"path": ["/vibes-api/*", "/vibes", "/vibes/", "/vibes/*", "/relations", "/relations/", "/relations/*"]}],
  "handle": [{"handler": "reverse_proxy", "upstreams": [{"dial": "127.0.0.1:$PORT"}]}]
}
EOF
)

# Find the index of the public route by checking the host match
PUBLIC_IDX=$(curl -s http://127.0.0.1:2019/config/apps/http/servers/srv0/routes/ \
  | bun -e 'const r=JSON.parse(require("fs").readFileSync("/dev/stdin","utf8"));for(let i=0;i<r.length;i++){if(r[i].match?.[0]?.host?.includes("public.iskrah-0ba5bd85.sandbox.dev")){console.log(i);process.exit(0);}}console.log(-1);')

if [ "$PUBLIC_IDX" = "-1" ]; then
  echo "could not find public route in caddy config"
  exit 1
fi

# Check if our proxy route is already present
ALREADY=$(curl -s "http://127.0.0.1:2019/config/apps/http/servers/srv0/routes/$PUBLIC_IDX/handle/0/routes/" \
  | bun -e 'const r=JSON.parse(require("fs").readFileSync("/dev/stdin","utf8"));const hit=r.find(x=>x.match?.[0]?.path?.some(p=>p.includes("vibes-api")));console.log(hit?"yes":"no");')

if [ "$ALREADY" = "yes" ]; then
  echo "caddy already patched"
else
  curl -s -X PUT "http://127.0.0.1:2019/config/apps/http/servers/srv0/routes/$PUBLIC_IDX/handle/0/routes/0" \
    -H "Content-Type: application/json" --data-binary "$ROUTE_JSON" > /dev/null
  echo "patched caddy"
fi

echo "ready: https://public.iskrah-0ba5bd85.sandbox.dev/vibes/"
