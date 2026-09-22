#!/bin/bash
# Installs the text relay as a background service on this Mac.
# Re-running it is safe: it reinstalls the service and leaves your config alone.
set -euo pipefail

LABEL="com.wholesalepayments.wprelay"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="${WP_RELAY_HOME:-$HOME/.wp-relay}"
CONFIG="$HOME_DIR/config.json"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/wp-relay.log"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "This installer only runs on macOS — the relay has to live on the Mac that has iMessage."

NODE="$(command -v node || true)"
[ -n "$NODE" ] || die "Node is not installed. Install it first:  brew install node"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node 18 or newer is required (found $(node -v))."

mkdir -p "$HOME_DIR" "$HOME/Library/LaunchAgents" "$(dirname "$LOG")"
chmod 700 "$HOME_DIR"

if [ ! -f "$CONFIG" ]; then
  cp "$DIR/config.example.json" "$CONFIG"
  chmod 600 "$CONFIG"
  say "Created $CONFIG"
fi
chmod 600 "$CONFIG"

# The token can be handed straight to this script. No editor, and no risk of
# pasting it onto a command line where the shell treats it as a filename.
TOKEN="${1:-}"
if [ -n "$TOKEN" ]; then
  node -e '
    const fs = require("fs");
    const file = process.argv[1], token = process.argv[2];
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    cfg.relayToken = token;
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  ' "$CONFIG" "$TOKEN" || die "Could not write the token into $CONFIG"
  say "Token saved (${TOKEN:0:8}...)"
fi

# Never install around a config that still holds the placeholder — that just
# produces a service that restarts forever being told its token is wrong.
CURRENT_TOKEN="$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).relayToken||""))}catch(e){}' "$CONFIG")"
case "$CURRENT_TOKEN" in
  *paste*|*dashboard*|"")
    say "Almost there - the relay token is not set yet."
    echo
    echo "Get one from the dashboard (Texting -> Mac relay -> Generate), then run:"
    echo
    echo "    ./install.sh <paste-the-token-here>"
    echo
    echo "Or edit it by hand:  open -e \"$CONFIG\""
    exit 0
    ;;
esac
if [ "${#CURRENT_TOKEN}" -lt 24 ]; then
  die "The relay token in $CONFIG looks too short to be real (${#CURRENT_TOKEN} characters). Generate a new one, then run: ./install.sh <token>"
fi

# Stop any previous copy before replacing it.
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true

sed -e "s|__NODE__|$NODE|g" \
    -e "s|__RELAY__|$DIR/relay.js|g" \
    -e "s|__LOG__|$LOG|g" \
    -e "s|__DIR__|$DIR|g" \
    "$DIR/com.wholesalepayments.wprelay.plist.template" > "$PLIST"

launchctl bootstrap "gui/$UID" "$PLIST" 2>/dev/null || launchctl load "$PLIST"
launchctl kickstart -k "gui/$UID/$LABEL" 2>/dev/null || true

say "Installed and running. It starts automatically when you log in."
echo
echo "  Watch it:    tail -f \"$LOG\""
echo "  Stop it:     launchctl bootout gui/$UID/$LABEL"
echo "  Start it:    launchctl bootstrap gui/$UID \"$PLIST\""
echo "  Settings:    open -e \"$CONFIG\""
echo
say "Two macOS permissions to grant"
echo
echo "1. Automation — lets the relay tell Messages to send. Nothing sends without it."
echo "   System Settings → Privacy & Security → Automation → enable Messages"
echo "   for your terminal (or for node). macOS usually prompts on the first send."
echo
echo "2. Full Disk Access — lets the relay read the Messages database, which is where"
echo "   delivery receipts, read receipts AND replies all come from."
echo "   System Settings → Privacy & Security → Full Disk Access → + → $NODE"
echo
echo "Without #1 nothing sends. Without #2 texts go out but nothing comes back."
