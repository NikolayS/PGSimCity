#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
url="${1:-http://127.0.0.1:5173/}"
output="${2:-/tmp/pgsimcity-v0.20.0-walkthrough.mp4}"
port="${CDP_PORT:-9780}"
seconds="${DEMO_SECONDS:-140}"
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
available_kib="$(df -Pk "${output_dir}" | awk 'NR == 2 { print $4 }')"
if [[ -z "${available_kib}" ]] || ((available_kib < minimum_kib)); then
  echo "At least 2 GiB free is required; ${output_dir} has ${available_kib:-unknown} KiB." >&2
  exit 2
fi

echo "Capturing ${seconds} deterministic seconds at 1280x720 and 30 fps."
echo "Frames stream directly to ffmpeg; no PNG frame directory is created."

CDP_PORT="${port}" \
CDP_SEQUENCE="${script_dir}/demo-video-sequence.mjs" \
DEMO_SECONDS="${seconds}" \
DEMO_OVERWRITE="${DEMO_OVERWRITE:-0}" \
node "${script_dir}/shoot.mjs" \
  "${url}" "${output}" "${DEMO_WAIT_MS:-30000}" 1280 720

ffprobe \
  -v error \
  -select_streams v:0 \
  -show_entries stream=codec_name,width,height,r_frame_rate,pix_fmt,duration \
  -of default=noprint_wrappers=1 \
  "${output}"

size="$(du -h "${output}" | awk '{ print $1 }')"
digest="$(sha256sum "${output}" | awk '{ print $1 }')"
echo "Video: ${output} (${size})"
echo "SHA-256: ${digest}"
