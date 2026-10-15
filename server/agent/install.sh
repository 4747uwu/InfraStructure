#!/usr/bin/env bash
# Installs the Router Hub monitoring agent on this server.
#
#   curl -fsSL http://HUB/agent/install.sh | sudo bash -s -- --hub http://HUB --token TOKEN [options]
#
# Options
#   --storage PATH[,PATH]    the mounted DICOM storage to watch, e.g. /mnt/dicom
#                            (Orthanc's own storage is found automatically when it can be)
#   --orthanc-url URL[,URL]  Orthanc's REST address, if it cannot be found automatically
#   --orthanc-user USER      Orthanc login, when its REST API asks for one
#   --orthanc-pass PASS
#   --interval SECONDS       how often to report (default 60)
#
# Running it again updates the agent and its settings. Nothing is deleted.
set -euo pipefail

HUB="" TOKEN="" STORAGE="" OURL="" OUSER="" OPASS="" INTERVAL="60"

die() {
  echo "install: $*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --hub) HUB="${2:-}"; shift 2 ;;
    --token) TOKEN="${2:-}"; shift 2 ;;
    --storage) STORAGE="${2:-}"; shift 2 ;;
    --orthanc-url) OURL="${2:-}"; shift 2 ;;
    --orthanc-user) OUSER="${2:-}"; shift 2 ;;
    --orthanc-pass) OPASS="${2:-}"; shift 2 ;;
    --interval) INTERVAL="${2:-}"; shift 2 ;;
    *) die "unknown option $1" ;;
  esac
done

[ -n "$HUB" ] || die "--hub is required (the Router Hub address)"
[ -n "$TOKEN" ] || die "--token is required (shown in Router Hub when you add the server)"
case "$INTERVAL" in '' | *[!0-9]*) die "--interval must be a number of seconds" ;; esac
[ "$INTERVAL" -ge 30 ] || die "--interval must be at least 30 seconds"
[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
command -v curl >/dev/null || die "curl is required"
[ -r /proc/stat ] || die "this agent needs Linux"
HUB="${HUB%/}"

curl -fsS -m 15 "$HUB/api/health" >/dev/null || die "cannot reach Router Hub at $HUB"

echo "==> Installing the agent to /opt/routerhub-agent"
mkdir -p /opt/routerhub-agent
curl -fsS -m 30 "$HUB/agent/routerhub-agent.sh" -o /opt/routerhub-agent/routerhub-agent.sh.new
mv -f /opt/routerhub-agent/routerhub-agent.sh.new /opt/routerhub-agent/routerhub-agent.sh
chmod 755 /opt/routerhub-agent/routerhub-agent.sh

# Values are single-quoted, so the file can be sourced safely whatever they contain.
quote() {
  local s=$1 q="'" escaped="'\\''"
  printf "'%s'" "${s//$q/$escaped}"
}

echo "==> Writing /etc/routerhub-agent.conf"
(
  umask 077
  {
    echo "# Router Hub monitoring agent. Re-run install.sh to change these."
    echo "HUB_URL=$(quote "$HUB")"
    echo "AGENT_TOKEN=$(quote "$TOKEN")"
    echo "STORAGE_PATHS=$(quote "$STORAGE")"
    echo "ORTHANC_URL=$(quote "$OURL")"
    echo "ORTHANC_USER=$(quote "$OUSER")"
    echo "ORTHANC_PASS=$(quote "$OPASS")"
    echo "INTERVAL=$(quote "$INTERVAL")"
  } >/etc/routerhub-agent.conf
)

echo "==> Sending a first report"
/opt/routerhub-agent/routerhub-agent.sh || die "the first report failed - see the message above"

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  echo "==> Scheduling it every ${INTERVAL}s with systemd"
  cat >/etc/systemd/system/routerhub-agent.service <<'UNIT'
[Unit]
Description=Router Hub monitoring agent (one report)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/opt/routerhub-agent/routerhub-agent.sh
Nice=10
UNIT
  cat >/etc/systemd/system/routerhub-agent.timer <<UNIT
[Unit]
Description=Send Router Hub monitoring reports every ${INTERVAL}s

[Timer]
OnBootSec=30s
OnUnitActiveSec=${INTERVAL}s
AccuracySec=1s

[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --now routerhub-agent.timer >/dev/null
  echo
  echo "Done. This server now reports to $HUB every ${INTERVAL}s."
  echo "  Status:  systemctl status routerhub-agent.timer"
  echo "  Pause:   systemctl disable --now routerhub-agent.timer"
else
  echo "==> Scheduling it every minute with cron (no systemd found)"
  echo "* * * * * root /opt/routerhub-agent/routerhub-agent.sh >/dev/null 2>&1" >/etc/cron.d/routerhub-agent
  chmod 644 /etc/cron.d/routerhub-agent
  echo
  echo "Done. This server now reports to $HUB every minute."
fi
