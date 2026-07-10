#!/usr/bin/env bash
# Screenshot a Bauplaner view without a human in the loop.
#
#   cli/dev/screenshot.sh <view> <out.png> [sh3d]
#     view : uebersicht | modell | fahrplan | bauteile | feuchte | kosten | material | raumklima | dokumentation
#     out  : output PNG path
#     sh3d : model to load (default: the bundled demo cli/demo/beispielhaus.sh3d)
#
# How it works: GNOME apps are single-instance per app-id, so this launches a
# SECOND instance under a distinct id (BP_APP_ID) — it won't hijack a Bauplaner
# you already have open. GJSIFY_DEVTOOLS=1 exports the org.gjsify.Devtools D-Bus
# interface, whose Screenshot method renders the window in-process via the GSK
# renderer (see cli/dev/dbus-shot.js). The bundled demo model gives the views
# something to render — the reason a sample project is shipped at all.
set -euo pipefail

VIEW="${1:?usage: screenshot.sh <view> <out.png> [sh3d]}"
OUT="${2:?usage: screenshot.sh <view> <out.png> [sh3d]}"
HERE="$(cd "$(dirname "$0")" && pwd)"
CLI="$(cd "$HERE/.." && pwd)"
# Default to the demo project sidecar (has costs/assemblies/diagnoses so the
# data-driven views render content); fall back to the bare .sh3d.
DEMO="$CLI/demo/beispielhaus.ecoretrofit.json"
[ -f "$DEMO" ] || DEMO="$CLI/demo/beispielhaus.sh3d"
SH3D="${3:-$DEMO}"

# A UNIQUE app-id per invocation. GNOME dedups instances by the D-Bus app-id
# (not the process argv), so a fresh id always spawns a fresh window — an
# orphaned prior shot can never be re-activated in this one's place (which would
# silently screenshot the wrong view). The id is distinct from the real app
# (eu.jumplink.Bauplaner), so this never hijacks a Bauplaner you have open.
# Override with BP_SHOT_APP_ID.
APP_ID="${BP_SHOT_APP_ID:-eu.jumplink.BauplanerShot$$}"
OBJ="/$(printf '%s' "$APP_ID" | tr . /)/devtools"
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}" DISPLAY="${DISPLAY:-:0}"

# setsid puts the app in its own session/process group so the trap can reap the
# whole tree (subshell → gjsify → gjs); killing the bare subshell PID would
# orphan the gjs child, which then lingers and blocks future single-instance runs.
setsid env GJSIFY_DEVTOOLS=1 BP_APP_ID="$APP_ID" BP_APP_FILE="$SH3D" BP_APP_VIEW="$VIEW" \
    bash -c "cd \"$CLI\" && exec gjsify run start:app" >/tmp/bauplaner-shot.log 2>&1 &
APP_PID=$!
trap 'kill -- -"$APP_PID" 2>/dev/null || kill "$APP_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if gdbus call --session --dest "$APP_ID" --object-path "$OBJ" \
       --method org.gjsify.Devtools.GetStatus >/dev/null 2>&1; then break; fi
  sleep 0.5
done
sleep 2.5   # let the GSK renderer lay out a few frames
gjs -m "$HERE/dbus-shot.js" "$APP_ID" "$OBJ" "$OUT"
