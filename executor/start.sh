#!/bin/bash
# Start both executor and ws-feed
# Usage: ./start.sh

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# Load env if exists
[ -f "../.env" ] && export $(grep -v '^#' ../.env | xargs)

# Required env vars
: "${PRIVATE_KEY:?PRIVATE_KEY required}"
: "${POLYMARKET_API_KEY:?POLYMARKET_API_KEY required}"
: "${POLYMARKET_SECRET:?POLYMARKET_SECRET required}"
: "${POLYMARKET_PASSPHRASE:?POLYMARKET_PASSPHRASE required}"
export CLOB_PROXY_URL="${CLOB_PROXY_URL:-https://proxy-rosy-sigma-25.vercel.app}"

echo "=== Starting Polymarket Trading Infrastructure ==="

# Kill existing
pkill -f "node.*index.js" 2>/dev/null
pkill -f "node.*ws-feed.js" 2>/dev/null
sleep 1

# Start executor
nohup node index.js > /tmp/executor.log 2>&1 &
echo "Executor PID: $! (port 3002)"

# Wait for executor to be ready
sleep 2

# Start WebSocket feed
nohup node ws-feed.js > /tmp/ws-feed.log 2>&1 &
echo "WS Feed PID: $! (port 3003)"

sleep 2
echo
echo "Health checks:"
curl -s localhost:3002/health
echo
curl -s localhost:3003/health
echo
echo
echo "=== Infrastructure Ready ==="
