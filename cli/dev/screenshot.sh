#!/usr/bin/env bash
# Screenshot a Bauplaner view without a human in the loop.
#
#   cli/dev/screenshot.sh <view> <out.png> [sh3d]
#     view : uebersicht | modell | fahrplan | bauteile | feuchte | kosten | material | raumklima | dokumentation
#     out  : output PNG path
#     sh3d : model to load (default: the bundled demo cli/demo/beispielhaus.sh3d)
#
#   BP_SHOT_SIZE="W H"      window size before capture
#   BP_SHOT_SETTLE=s        seconds to settle before capturing (default 2.5)
#   BP_APP_DIALOG=          open a dialog on start, e.g. "kosten-add"
#   BP_SHOT_ACTIVATE=       press a widget first, e.g. "GtkButton:suggested-action"
#                           (type[:css-class]); the capture FAILS if it is missing or inert
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
# The WORKSPACE gjsify, never whatever is on PATH. A global CLI of a different
# version does not fail loudly — it runs the wrong bundler/loader against these
# pins and the command quietly does nothing useful. Falls back to PATH only when
# the project has not been installed yet, where there is nothing else to use.
GJSIFY="$CLI/../node_modules/.bin/gjsify"
[ -x "$GJSIFY" ] || GJSIFY="$(command -v gjsify)"
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
    BP_APP_DIALOG="${BP_APP_DIALOG:-}" \
    bash -c "cd \"$CLI\" && exec \"$GJSIFY\" run start:app" >/tmp/bauplaner-shot.log 2>&1 &
APP_PID=$!
trap 'kill -- -"$APP_PID" 2>/dev/null || kill "$APP_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if gdbus call --session --dest "$APP_ID" --object-path "$OBJ" \
       --method org.gjsify.Devtools.GetStatus >/dev/null 2>&1; then break; fi
  sleep 0.5
done
# Optional: resize before capturing (BP_SHOT_SIZE="<width> <height>") so a tall
# view (e.g. the dashboard) fits into one shot instead of being scroll-clipped.
if [ -n "${BP_SHOT_SIZE:-}" ]; then
  gdbus call --session --dest "$APP_ID" --object-path "$OBJ" \
    --method org.gjsify.Devtools.ResizeWindow ${BP_SHOT_SIZE} >/dev/null 2>&1 || true
fi
sleep "${BP_SHOT_SETTLE:-2.5}"   # let the GSK renderer lay out a few frames

# Optional: press something first (BP_SHOT_ACTIVATE="GtkButton:suggested-action").
#
# A screenshot proves a widget was DRAWN, never that it does anything — and a button whose
# activate_action names an action the widget tree cannot resolve fails in total silence (the class
# check-actions.js exists for). So: find the widget, activate it, and refuse to produce a picture if
# either step fails. A rig that cannot report failure is a rig that lies.
if [ -n "${BP_SHOT_ACTIVATE:-}" ]; then
  WPATH="$(gjs -m "$HERE/dbus-find.js" "$APP_ID" "$OBJ" "$BP_SHOT_ACTIVATE")" || {
    echo "no widget matches $BP_SHOT_ACTIVATE" >&2; exit 1;
  }
  echo "activating $BP_SHOT_ACTIVATE at $WPATH" >&2
  RESULT="$(gdbus call --session --dest "$APP_ID" --object-path "$OBJ" \
    --method org.gjsify.Devtools.ActivateWidget "$WPATH")"
  case "$RESULT" in
    *true*) : ;;
    *) echo "ActivateWidget refused $WPATH: $RESULT" >&2; exit 1 ;;
  esac
  sleep "${BP_SHOT_SETTLE:-2.5}"   # whatever it triggered needs its own settle
fi

gjs -m "$HERE/dbus-shot.js" "$APP_ID" "$OBJ" "$OUT"
