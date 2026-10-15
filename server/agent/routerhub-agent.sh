#!/usr/bin/env bash
# Router Hub monitoring agent.
#
# Reads CPU, memory, disk and Orthanc figures on this server and sends them to Router Hub.
# install.sh puts it in /opt/routerhub-agent and runs it every minute; settings come from
# /etc/routerhub-agent.conf. Needs only bash, curl and the usual coreutils.
#
#   routerhub-agent.sh            collect and send one report (what the timer runs)
#   routerhub-agent.sh --print    collect and print the report, send nothing
#
# It only reads: /proc, df, the Docker container list, and Orthanc's REST API.
set -uo pipefail

AGENT_VERSION="1.0.0"
CONF="${ROUTERHUB_AGENT_CONF:-/etc/routerhub-agent.conf}"
# shellcheck disable=SC1090
[ -r "$CONF" ] && . "$CONF"

MODE="send"
[ "${1:-}" = "--print" ] && MODE="print"

HUB_URL="${HUB_URL:-}"
AGENT_TOKEN="${AGENT_TOKEN:-}"
STORAGE_PATHS="${STORAGE_PATHS:-}" # comma-separated, e.g. /mnt/dicom
ORTHANC_URL="${ORTHANC_URL:-}"     # comma-separated; empty = find Orthanc automatically
ORTHANC_USER="${ORTHANC_USER:-}"
ORTHANC_PASS="${ORTHANC_PASS:-}"
INTERVAL="${INTERVAL:-60}"

if [ "$MODE" = "send" ] && { [ -z "$HUB_URL" ] || [ -z "$AGENT_TOKEN" ]; }; then
  echo "routerhub-agent: HUB_URL and AGENT_TOKEN must be set in $CONF" >&2
  exit 2
fi

# ---- JSON helpers -----------------------------------------------------------

js() { # JSON string
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\t'/ }
  s=${s//$'\r'/}
  s=${s//$'\n'/ }
  printf '"%s"' "$s"
}

jn() { # JSON number, or null when the value is not a plain non-negative number
  case $1 in
    '' | *[!0-9.]* | *.*.*) printf 'null' ;;
    *) printf '%s' "$1" ;;
  esac
}

# ---- host -------------------------------------------------------------------

hostname_value=$(hostname 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null || echo unknown)
os_value=$( (. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-Linux}") || echo Linux)
kernel_value=$(uname -r 2>/dev/null || echo "")
read -r uptime_value _ </proc/uptime
uptime_value=${uptime_value%.*}
cores_value=$(nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo)

# ---- CPU: busy share of all ticks over one second ---------------------------

cpu_sample() {
  local _cpu u n s i w q sq st _rest
  read -r _cpu u n s i w q sq st _rest </proc/stat
  echo "$((u + n + s + i + w + q + sq + st)) $((i + w))"
}
read -r t1 i1 <<<"$(cpu_sample)"
sleep 1
read -r t2 i2 <<<"$(cpu_sample)"
cpu_pct=$(awk -v dt=$((t2 - t1)) -v di=$((i2 - i1)) 'BEGIN { if (dt > 0) printf "%.1f", (1 - di / dt) * 100; else print 0 }')
read -r load1 load5 load15 _ </proc/loadavg

# ---- memory -----------------------------------------------------------------

read -r mem_total mem_avail swap_total swap_free < <(awk '
  /^MemTotal:/ { t = $2 } /^MemAvailable:/ { a = $2 } /^SwapTotal:/ { st = $2 } /^SwapFree:/ { sf = $2 }
  END { printf "%.0f %.0f %.0f %.0f\n", t * 1024, a * 1024, st * 1024, sf * 1024 }' /proc/meminfo)

# ---- disks ------------------------------------------------------------------

disks_json=""
seen_fs="|"
while read -r fs type size used avail _pct mount; do
  [ -z "${mount:-}" ] && continue
  case "$mount" in
    /snap/* | /boot | /boot/* | /run | /run/* | /dev | /dev/* | /sys | /sys/* | /proc | /proc/* | /var/lib/docker/*) continue ;;
  esac
  case "$seen_fs" in *"|$fs|"*) continue ;; esac # same device mounted twice
  seen_fs="$seen_fs$fs|"
  disks_json+="${disks_json:+,}{\"mount\":$(js "$mount"),\"fs\":$(js "$fs"),\"type\":$(js "$type"),\"sizeBytes\":$(jn "$size"),\"usedBytes\":$(jn "$used"),\"availBytes\":$(jn "$avail")}"
done < <(df -B1 -P -T -x tmpfs -x devtmpfs -x overlay -x squashfs -x efivarfs 2>/dev/null | tail -n +2)

# ---- Orthanc: where it runs and where it keeps its files --------------------

targets=() # "name|url|storagePath"

# Where a containerised Orthanc really keeps its DICOM files, as a host path.
# Follows Orthanc's own setting (environment, then the mounted config files, then the
# image default) and translates it through the container's mounts. Prints nothing when
# the files live inside the container itself.
container_storage() {
  local cid=$1 mounts conf_src dir
  mounts=$(docker inspect -f '{{range .Mounts}}{{.Destination}}|{{.Source}}{{"\n"}}{{end}}' "$cid" 2>/dev/null)
  dir=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$cid" 2>/dev/null | sed -n 's/^ORTHANC__STORAGE_DIRECTORY=//p' | head -n 1)
  if [ -z "$dir" ]; then
    conf_src=$(awk -F'|' '$1 == "/etc/orthanc" { print $2; exit }' <<<"$mounts")
    if [ -n "$conf_src" ]; then
      dir=$(grep -hoE '"StorageDirectory"[[:space:]]*:[[:space:]]*"[^"]+"' "$conf_src"/*.json 2>/dev/null | head -n 1 | sed -E 's/.*:[[:space:]]*"([^"]+)"/\1/')
    fi
  fi
  [ -z "$dir" ] && dir=/var/lib/orthanc/db
  awk -F'|' -v p="$dir" '
    NF == 2 && (p == $1 || index(p, $1 "/") == 1) && length($1) > best { best = length($1); out = $2 substr(p, length($1) + 1) }
    END { if (out != "") print out }' <<<"$mounts"
}

if [ -n "$ORTHANC_URL" ]; then
  IFS=',' read -ra urls <<<"$ORTHANC_URL"
  for u in "${urls[@]}"; do
    [ -n "$u" ] && targets+=("orthanc|${u%/}|")
  done
elif command -v docker >/dev/null 2>&1; then
  while IFS='|' read -r cid image cname ports; do
    case "${image,,}" in *orthanc*) ;; *) continue ;; esac
    url=""
    host_port=$(grep -oE ':[0-9]+->8042/tcp' <<<"$ports" | head -n 1 | sed -E 's/^:([0-9]+)->.*/\1/')
    if [ -n "$host_port" ]; then
      url="http://127.0.0.1:$host_port"
    else
      ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$cid" 2>/dev/null | awk '{ print $1 }')
      [ -n "$ip" ] && url="http://$ip:8042"
    fi
    store=$(container_storage "$cid")
    # Not mounted from the host: the files sit in Docker's own data directory.
    [ -z "$store" ] && store="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)"
    targets+=("$cname|$url|$store")
  done < <(docker ps --format '{{.ID}}|{{.Image}}|{{.Names}}|{{.Ports}}' 2>/dev/null)
fi

# A plain install answering on the default port.
if [ ${#targets[@]} -eq 0 ] && [ -z "$ORTHANC_URL" ] && curl -s -m 3 -o /dev/null http://127.0.0.1:8042/ 2>/dev/null; then
  store=$(grep -hoE '"StorageDirectory"[[:space:]]*:[[:space:]]*"[^"]+"' /etc/orthanc/*.json 2>/dev/null | head -n 1 | sed -E 's/.*:[[:space:]]*"([^"]+)"/\1/')
  [ -z "$store" ] && [ -d /var/lib/orthanc/db ] && store=/var/lib/orthanc/db
  targets+=("orthanc|http://127.0.0.1:8042|$store")
fi

orthanc_get() { # $1 = base url, $2 = path; sets http_code and body
  local auth=() out
  [ -n "$ORTHANC_USER" ] && auth=(-u "$ORTHANC_USER:$ORTHANC_PASS")
  out=$(curl -s -m 10 ${auth[@]+"${auth[@]}"} -w $'\n%{http_code}' "$1$2" 2>/dev/null) || true
  http_code=${out##*$'\n'}
  body=${out%$'\n'*}
  [ "$body" = "$out" ] && body=""
}

looks_like_object() { [[ $1 == \{*\} ]]; }

orthanc_json=""
storage_paths=()
for t in ${targets[@]+"${targets[@]}"}; do
  IFS='|' read -r tname turl tstore <<<"$t"
  stats="null"
  system="null"
  code=0
  if [ -n "$turl" ]; then
    orthanc_get "$turl" "/statistics"
    code=${http_code:-0}
    looks_like_object "$body" && [ "$code" = "200" ] && stats=$body
    orthanc_get "$turl" "/system"
    looks_like_object "$body" && [ "$http_code" = "200" ] && system=$body
  fi
  [ -n "$tstore" ] && storage_paths+=("$tstore|orthanc:$tname")
  orthanc_json+="${orthanc_json:+,}{\"name\":$(js "$tname"),\"url\":$(js "$turl"),\"storagePath\":$(js "$tstore"),\"httpStatus\":$(jn "$code"),\"statistics\":$stats,\"system\":$system}"
done

# ---- storage volumes: configured paths plus each Orthanc's storage ----------

if [ -n "$STORAGE_PATHS" ]; then
  IFS=',' read -ra configured <<<"$STORAGE_PATHS"
  for p in "${configured[@]}"; do
    [ -n "$p" ] && storage_paths+=("$p|configured")
  done
fi

storage_json=""
seen_paths="|"
for entry in ${storage_paths[@]+"${storage_paths[@]}"}; do
  IFS='|' read -r spath slabel <<<"$entry"
  case "$seen_paths" in *"|$spath|"*) continue ;; esac
  seen_paths="$seen_paths$spath|"
  line=$(df -B1 -P -T "$spath" 2>/dev/null | tail -n 1)
  if [ -z "$line" ]; then
    storage_json+="${storage_json:+,}{\"path\":$(js "$spath"),\"label\":$(js "$slabel"),\"error\":\"path not found\"}"
    continue
  fi
  read -r fs type size used avail _pct mount <<<"$line"
  storage_json+="${storage_json:+,}{\"path\":$(js "$spath"),\"label\":$(js "$slabel"),\"mount\":$(js "$mount"),\"fs\":$(js "$fs"),\"type\":$(js "$type"),\"sizeBytes\":$(jn "$size"),\"usedBytes\":$(jn "$used"),\"availBytes\":$(jn "$avail")}"
done

# ---- report -----------------------------------------------------------------

payload="{\"agent\":$(js "$AGENT_VERSION"),\"interval\":$(jn "$INTERVAL"),\
\"host\":{\"hostname\":$(js "$hostname_value"),\"os\":$(js "$os_value"),\"kernel\":$(js "$kernel_value"),\"uptimeSec\":$(jn "$uptime_value"),\"cores\":$(jn "$cores_value")},\
\"cpu\":{\"usagePct\":$(jn "$cpu_pct"),\"load1\":$(jn "$load1"),\"load5\":$(jn "$load5"),\"load15\":$(jn "$load15")},\
\"memory\":{\"totalBytes\":$(jn "$mem_total"),\"availableBytes\":$(jn "$mem_avail"),\"swapTotalBytes\":$(jn "$swap_total"),\"swapFreeBytes\":$(jn "$swap_free")},\
\"disks\":[${disks_json}],\"storage\":[${storage_json}],\"orthanc\":[${orthanc_json}]}"

if [ "$MODE" = "print" ]; then
  printf '%s\n' "$payload"
  exit 0
fi

# The token goes in a header read from a file descriptor, so it never shows in the process list.
response=$(printf '%s' "$payload" | curl -sS -m 30 -X POST \
  -H "Content-Type: application/json" \
  -H @<(printf 'Authorization: Bearer %s\n' "$AGENT_TOKEN") \
  --data-binary @- -w $'\n%{http_code}' "${HUB_URL%/}/api/agent/report" 2>&1)
status=${response##*$'\n'}
if [ "$status" = "200" ]; then
  echo "routerhub-agent: report sent (cpu ${cpu_pct}%)"
  exit 0
fi
echo "routerhub-agent: the hub did not accept the report (HTTP ${status:-none}): ${response%$'\n'*}" >&2
exit 1
