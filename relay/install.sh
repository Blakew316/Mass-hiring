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
  echo "Fill in your relay token and BlueBubbles password, then run this script again:"
  echo "  open -e \"$CONFIG\""
  exit 0
fi
chmod 600 "$CONFIG"

# Stop any previous copy before replacing it.
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true

sed -e "s|__NODE__|$NODE|g" \
    -e "s|__RELAY__|$DIR/relay.js|g" \
    -e "s|__LOG__|$LOG|g" \
    -e "s|__DIR__|$DIR|g" \
    "$DIR/com.wholesalepayments.wprelay.plist.template" > "$PLIST"

launchctl bootstrap "gui/$UID" "$PLIST" 2>/dev/null || launchctl load "$PLIST"
launchctl kickstart -k "gui/$UID/$LABEL" 2>/dev/null || true

say "Installed. The relay now starts automatically when you log in."
echo
echo "  Watch it:    tail -f \"$LOG\""
echo "  Stop it:     launchctl bootout gui/$UID/$LABEL"
echo "  Start it:    launchctl bootstrap gui/$UID \"$PLIST\""
echo "  Settings:    open -e \"$CONFIG\""
echo
say "One more thing — Full Disk Access"
echo "Delivery and read receipts are read from the Messages database, which macOS"
echo "protects. Grant Full Disk Access to Node so the relay can read it:"
echo "  System Settings → Privacy & Security → Full Disk Access → + → $NODE"
echo "(Texting still works without this; you just will not see delivered/read.)"
