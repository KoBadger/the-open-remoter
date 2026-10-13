#!/data/data/com.termux/files/usr/bin/bash
# ===========================================================================
#  Receive a full config sync from the desktop
#
#  The desktop packs its OpenCode config (credentials, opencode.json, agents)
#  into a single tar and serves it. This script pulls it and unpacks it into
#  the proot container, then restarts the server so the new providers load.
#
#  Run in Termux:   bash sync-from-desktop.sh
# ===========================================================================
set -u

# Shared config: paths, ports, credentials. Sources config.env if present.
. "$(dirname "$0")/lib.sh"

DESKTOP_IP="${DESKTOP_IP:-100.108.250.70}"
DESKTOP_PORT="${DESKTOP_PORT:-8899}"
BASE="http://${DESKTOP_IP}:${DESKTOP_PORT}"
ARCHIVE="opencode-config-sync.tar.gz"

USER_NAME="$OPENCODE_USER"
PASS="$OPENCODE_PASS"

say() { printf "\n\033[1;36m==> %s\033[0m\n" "$*"; }
die() { printf "\033[1;31m[x] %s\033[0m\n" "$*"; exit 1; }

echo "=========================================="
echo " Sync config from desktop (${DESKTOP_IP}:${DESKTOP_PORT})"
echo "=========================================="

say "1/6  Downloading the config bundle"
curl -fsSL --connect-timeout 15 "$BASE/$ARCHIVE" -o "$HOME/$ARCHIVE" \
  || die "could not download $ARCHIVE from $BASE"
echo "    got $(wc -c < "$HOME/$ARCHIVE") bytes"

say "2/6  Verifying and listing the bundle"
tar -tzf "$HOME/$ARCHIVE" | sed 's/^/    /' || die "archive is not a valid tar.gz"

say "3/6  Unpacking into the container"
# proot's $HOME is /root, so files must land there. Pass the archive in over
# stdin as base64 to sidestep proot path mapping entirely.
base64 -w0 "$HOME/$ARCHIVE" | proot-distro login "$BOX" -- /bin/bash -c '
  set -e
  cd /root
  # Preserve the previous config so a bad sync can be undone.
  if [ -f /root/.config/opencode/opencode.json ]; then
    cp /root/.config/opencode/opencode.json /root/.config/opencode/opencode.json.prev
  fi
  if [ -f /root/.local/share/opencode/auth.json ]; then
    cp /root/.local/share/opencode/auth.json /root/.local/share/opencode/auth.json.prev
  fi
  base64 -d | tar -xzf - -C /root
  echo "    unpacked into /root"
' || die "unpack into $BOX failed"

say "4/6  Resulting config inside the container"
proot-distro login "$BOX" -- /bin/bash -c '
  echo "    ~/.config/opencode:"
  ls -1 /root/.config/opencode 2>/dev/null | sed "s/^/      /"
  echo "    ~/.config/opencode/agents:"
  ls -1 /root/.config/opencode/agents 2>/dev/null | sed "s/^/      /"
  echo "    ~/.local/share/opencode/auth.json:"
  if [ -f /root/.local/share/opencode/auth.json ]; then
    n=$(grep -o "\"[a-z0-9-]*\":" /root/.local/share/opencode/auth.json | sort -u | wc -l)
    echo "      credential provider keys: $n"
  else
    echo "      MISSING"
  fi
'

say "5/6  Restarting the server so new providers load"
if [ -x "$HOME/start-phone-opencode.sh" ]; then
  bash "$HOME/start-phone-opencode.sh"
else
  die "~/start-phone-opencode.sh missing - run setup-phone.sh first"
fi
echo -n "    waiting for the server "
for _ in $(seq 1 25); do
  if curl -fsS -m 3 -u "$USER_NAME:$PASS" -o /dev/null \
       "http://127.0.0.1:$SERVER_PORT/api/info" 2>/dev/null; then echo " ok"; break; fi
  echo -n "."
  sleep 2
done

say "6/6  Restarting the bridge"
[ -x "$HOME/start-phone-bridge.sh" ] && bash "$HOME/start-phone-bridge.sh"
sleep 5

say "Verification"
echo -n "  providers on the phone : "
curl -s -m 20 -u "$USER_NAME:$PASS" "http://127.0.0.1:$SERVER_PORT/api/provider" \
  | grep -o '"id":"[a-z0-9-]*"' | sed 's/"id":"//;s/"//' | sort -u | tr '\n' ' '
echo
echo -n "  models                 : "
curl -s -m 30 -u "$USER_NAME:$PASS" "http://127.0.0.1:$SERVER_PORT/api/model" \
  | grep -o '"id":"' | wc -l
echo -n "  bridge health          : "
curl -s -m 8 -u "$USER_NAME:$PASS" "http://127.0.0.1:$BRIDGE_PORT/global/health" || echo "(no response)"
echo
echo
echo "  If a provider is missing or the server will not start, roll back with:"
echo "     proot-distro login ubuntu -- /bin/bash -c 'cd /root/.config/opencode && mv opencode.json.prev opencode.json'"
echo "     proot-distro login ubuntu -- /bin/bash -c 'cd /root/.local/share/opencode && mv auth.json.prev auth.json'"
