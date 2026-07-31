#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
url="${1:-http://127.0.0.1:5173/}"
output="${2:-/tmp/pgsimcity-v0.23.0-walkthrough.mp4}"
port="${CDP_PORT:-9780}"
seconds="${DEMO_SECONDS:-147}"
start_seconds="${DEMO_START_SECONDS:-0}"
minimum_kib=$((2 * 1024 * 1024))

if [[ "${output}" != /* ]]; then
  output="${PWD}/${output}"
fi

if [[ ! "${port}" =~ ^[0-9]+$ ]] || ((port < 9500 || port > 9900)); then
  echo "CDP_PORT must be a unique integer from 9500 through 9900." >&2
  exit 2
fi

for command in curl df ffmpeg ffprobe node; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "Missing required command: ${command}" >&2
    exit 2
  fi
done

if ! curl --fail --silent --show-error --max-time 3 "${url}" >/dev/null; then
  echo "PGSimCity is not reachable at ${url}" >&2
  echo "Start it from ${repo_root} with: npm run dev -- --host 127.0.0.1" >&2
  exit 2
fi

if [[ -e "${output}" && "${DEMO_OVERWRITE:-0}" != "1" ]]; then
  echo "Refusing to overwrite ${output}; set DEMO_OVERWRITE=1 to replace it." >&2
  exit 2
fi

output_dir="$(dirname "${output}")"
mkdir -p "${output_dir}"
small_output="${DEMO_SMALL_OUTPUT:-${output%.mp4}-send.mp4}"
if [[ "${small_output}" != /* ]]; then
  small_output="${PWD}/${small_output}"
fi
if [[ "${DEMO_SKIP_SMALL:-0}" != "1" && -e "${small_output}" && "${DEMO_OVERWRITE:-0}" != "1" ]]; then
  echo "Refusing to overwrite ${small_output}; set DEMO_OVERWRITE=1 to replace it." >&2
  exit 2
fi
available_kib="$(df -Pk "${output_dir}" | awk 'NR == 2 { print $4 }')"
if [[ -z "${available_kib}" ]] || ((available_kib < minimum_kib)); then
  echo "At least 2 GiB free is required; ${output_dir} has ${available_kib:-unknown} KiB." >&2
  exit 2
fi

echo "Capturing ${seconds} deterministic seconds from timeline ${start_seconds}s at 1280x720 and 30 fps."
echo "Frames stream directly to ffmpeg; no PNG frame directory is created."

CDP_PORT="${port}" \
CDP_SEQUENCE="${script_dir}/demo-video-sequence.mjs" \
DEMO_SECONDS="${seconds}" \
DEMO_START_SECONDS="${start_seconds}" \
DEMO_OVERWRITE="${DEMO_OVERWRITE:-0}" \
node "${script_dir}/shoot.mjs" \
  "${url}" "${output}" "${DEMO_WAIT_MS:-30000}" 1280 720

ffprobe \
  -v error \
  -select_streams v:0 \
  -show_entries stream=codec_name,width,height,r_frame_rate,pix_fmt,duration \
  -of default=noprint_wrappers=1 \
  "${output}"

master_size="$(du -h "${output}" | awk '{ print $1 }')"
master_digest="$(sha256sum "${output}" | awk '{ print $1 }')"
echo "Video: ${output} (${master_size})"
echo "SHA-256: ${master_digest}"

if [[ "${DEMO_SKIP_SMALL:-0}" == "1" ]]; then
  exit 0
fi

passlog="$(mktemp "${output_dir}/.pgsimcity-demo-pass.XXXXXX")"
rm -f "${passlog}"
cleanup_passlog() {
  rm -f "${passlog}" "${passlog}-0.log" "${passlog}-0.log.mbtree"
}
trap cleanup_passlog EXIT

echo "Encoding a sendable companion at 1,350 kbit/s (strictly under 28 MB)."
ffmpeg \
  -hide_banner \
  -loglevel warning \
  -y \
  -i "${output}" \
  -an \
  -c:v libx264 \
  -preset slow \
  -b:v 1350k \
  -pass 1 \
  -passlogfile "${passlog}" \
  -pix_fmt yuv420p \
  -f null \
  /dev/null
ffmpeg \
  -hide_banner \
  -loglevel warning \
  -y \
  -i "${output}" \
  -an \
  -c:v libx264 \
  -preset slow \
  -b:v 1350k \
  -pass 2 \
  -passlogfile "${passlog}" \
  -pix_fmt yuv420p \
  -movflags +faststart \
  "${small_output}"

small_bytes="$(stat -c %s "${small_output}")"
if ((small_bytes >= 28000000)); then
  echo "Sendable companion is ${small_bytes} bytes; expected strictly under 28,000,000." >&2
  exit 1
fi

ffprobe \
  -v error \
  -select_streams v:0 \
  -show_entries stream=codec_name,width,height,r_frame_rate,pix_fmt,duration \
  -of default=noprint_wrappers=1 \
  "${small_output}"

small_size="$(du -h "${small_output}" | awk '{ print $1 }')"
small_digest="$(sha256sum "${small_output}" | awk '{ print $1 }')"
echo "Sendable video: ${small_output} (${small_size}; ${small_bytes} bytes)"
echo "SHA-256: ${small_digest}"
