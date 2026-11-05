#!/bin/bash
# ---------------------------------------------------------------------------
#  Sandbox Seeder launcher for macOS
#  Starts the local web server (server.pl) and opens the app in your default
#  browser. Uses only what ships with macOS (Perl and curl): no installs.
#
#  Usage:  double-click start.command        (port 5050)
#          ./start.command 5051              (custom port; register the matching callback URL)
# ---------------------------------------------------------------------------
cd "$(dirname "$0")" || exit 1
printf '\033]0;Sandbox Seeder\007'

PORT="${1:-5050}"

fail() {
  echo
  echo "  $1"
  echo "  Help: README.md, section \"Troubleshooting\"."
  echo
  read -r -n 1 -s -p "  Press any key to close this window." _
  echo
  exit 1
}

case "$PORT" in
  ''|*[!0-9]*) fail "ERROR: \"$PORT\" is not a port number. Example: ./start.command 5051" ;;
esac

echo
echo "  Sandbox Seeder - starting local server on http://localhost:$PORT/"
echo "  Keep this window open while you use the app. Press Ctrl+C to stop."
echo

[ -f server.pl ] || fail "ERROR: server.pl is missing next to start.command."
PERL=/usr/bin/perl
[ -x "$PERL" ] || PERL="$(command -v perl)"
[ -n "$PERL" ] || fail "ERROR: Perl was not found. It ships with macOS; ask IT if it was removed."

"$PERL" server.pl --port "$PORT" || fail "The server did not start or stopped with an error. See the messages above."
