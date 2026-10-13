#!/data/data/com.termux/files/usr/bin/bash
# ===========================================================================
#  Inspect and (optionally) roll back the config sync
#
#  The sync kept backups as .prev. This script shows what is on disk, what the
#  server currently reports, and can restore the previous config.
#
#  Run in Termux:
#     bash rollback-sync.sh            # inspect only
#     bash rollback-sync.sh --restore  # restore .prev backups and restart
# ===========================================================================
set -u

# Shared config: paths, ports, credentials. Sources config.env if present.
. "$(dirname "$0")/lib.sh"

USER_NAME="$OPENCODE_USER"
PASS="$OPENCODE_PASS"

say() { printf "\n\033[1;36m==> %s\033[0m\n" "$*"; }

say "1/3  Files inside the container"
proot-distro login "$BOX" -- /bin/bash -c '
  echo "  ~/.config/opencode:"
  ls -la /root/.config/opencode 2>/dev/null | grep -v "^total" | sed "s/^/    /"
  echo
  echo "  ~/.local/share/opencode:"
  ls -la /root/.local/share/opencode 2>/dev/null | grep -v "^total" | sed "s/^/    /"
  echo
  echo "  sizes:"
  for f in /root/.config/opencode/opencode.json \
           /root/.config/opencode/opencode.json.prev \
           /root/.config/opencode/opencode.json.bak \
           /root/.local/share/opencode/auth.json \
           /root/.local/share/opencode/auth.json.prev; do
    [ -f "$f" ] && echo "    $(wc -c < "$f") bytes  $f"
  done
'

say "2/3  What the running server reports"
echo -n "  providers: "
curl -s -m 20 -u "$USER_NAME:$PASS" "http://127.0.0.1:$SERVER_PORT/api/provider" \
  | grep -o '"id":"[a-z0-9-]*"' | sed 's/"id":"//;s/"//' | sort -u | tr '\n' ' '
echo
echo -n "  models   : "
curl -s -m 30 -u "$USER_NAME:$PASS" "http://127.0.0.1:$SERVER_PORT/api/model" \
  | grep -o '"id":"' | wc -l

if [ "${1:-}" != "--restore" ]; then
  echo
  echo "  Run 'bash rollback-sync.sh --restore' to restore the .prev backups."
  exit 0
fi

say "3/3  Restoring the .prev backups"
proot-distro login "$BOX" -- /bin/bash -c '
  set -e
  cd /root/.config/opencode
  if [ -f opencode.json.prev ]; then
    cp opencode.json opencode.json.synced
    mv opencode.json.prev opencode.json
    echo "    restored ~/.config/opencode/opencode.json"
  else
    echo "    no opencode.json.prev to restore"
  fi
  cd /root/.local/share/opencode
  if [ -f auth.json.prev ]; then
    cp auth.json auth.json.synced
    mv auth.json.prev auth.json
    echo "    restored ~/.local/share/opencode/auth.json"
  else
    echo "    no auth.json.prev to restore"
  fi
'

echo "  restarting the server..."
bash "$HOME/start-phone-opencode.sh" 2>/dev/null
for _ in $(seq 1 25); do
  curl -fsS -m 3 -u "$USER_NAME:$PASS" -o /dev/null \
    "http://127.0.0.1:$SERVER_PORT/api/info" 2>/dev/null && break
  sleep 2
done
[ -x "$HOME/start-phone-bridge.sh" ] && bash "$HOME/start-phone-bridge.sh"
sleep 5

echo
echo -n "  providers now: "
curl -s -m 20 -u "$USER_NAME:$PASS" "http://127.0.0.1:$SERVER_PORT/api/provider" \
  | grep -o '"id":"[a-z0-9-]*"' | sed 's/"id":"//;s/"//' | sort -u | tr '\n' ' '
echo
echo -n "  models now   : "
curl -s -m 30 -u "$USER_NAME:$PASS" "http://127.0.0.1:$SERVER_PORT/api/model" \
  | grep -o '"id":"' | wc -l
echo
echo -n "  bridge health: "
curl -s -m 8 -u "$USER_NAME:$PASS" "http://127.0.0.1:$BRIDGE_PORT/global/health" || echo "(no response)"
echo
