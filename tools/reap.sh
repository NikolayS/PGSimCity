#!/usr/bin/env bash
# Reap what the screenshot work leaves behind. Run every loop iteration.
set -uo pipefail
k=0
for pid in $(pgrep -f "remote-debugging-port" 2>/dev/null); do
  el=$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ')
  [ -n "$el" ] && [ "$el" -gt 900 ] && kill -9 "$pid" 2>/dev/null && k=$((k+1))
done
# Gate slots outlive a killed driver; mkdir is atomic but rmdir needs an owner.
find /tmp/claude-1000/cdp-gate -maxdepth 1 -type d -name 'slot*' -mmin +10 -exec rmdir {} \; 2>/dev/null
echo "reaped $k chrome"
