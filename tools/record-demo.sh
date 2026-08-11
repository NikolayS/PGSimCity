#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
url="${1:-http://127.0.0.1:5173/}"
output="${2:-/tmp/pgsimcity-v0.27.0-walkthrough.mp4}"
port="${CDP_PORT:-9780}"
seconds="${DEMO_SECONDS:-158}"
start_seconds="${DEMO_START_SECONDS:-0}"
minimum_kib=$((2 * 1024 * 1024))

if [[ "${output}" != /* ]]; then
  output="${PWD}/${output}"
fi

if [[ ! "${port}" =~ ^[0-9]+$ ]] || ((port < 9500 || port > 9900)); then
  echo "CDP_PORT must be a unique integer from 9500 through 9900." >&2
  exit 2
fi

for command in curl df ffmpeg ffprobe node pactl parec pulseaudio; do
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

pulse_started=0
pulse_module_id=""
passlog=""
cleanup() {
  if [[ -n "${passlog}" ]]; then
    rm -f "${passlog}" "${passlog}-0.log" "${passlog}-0.log.mbtree"
  fi
  if [[ -n "${pulse_module_id}" ]]; then
    pactl unload-module "${pulse_module_id}" >/dev/null 2>&1 || true
  fi
  if [[ "${pulse_started}" == "1" ]]; then
    pulseaudio --kill >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if ! pactl info >/dev/null 2>&1; then
  pulseaudio --start --exit-idle-time=-1
  pulse_started=1
fi
pulse_sink="pgsimcity_demo_${port}_$$"
pulse_module_id="$(
  pactl load-module module-null-sink \
    "sink_name=${pulse_sink}" \
    rate=48000 \
    channels=2
)"
if [[ ! "${pulse_module_id}" =~ ^[0-9]+$ ]]; then
  echo "Could not create the private PulseAudio sink for app-audio capture." >&2
  exit 1
fi

CDP_PORT="${port}" \
CDP_SEQUENCE="${script_dir}/demo-video-sequence.mjs" \
DEMO_SECONDS="${seconds}" \
DEMO_START_SECONDS="${start_seconds}" \
DEMO_OVERWRITE="${DEMO_OVERWRITE:-0}" \
DEMO_PULSE_SOURCE="${pulse_sink}.monitor" \
PULSE_SINK="${pulse_sink}" \
node "${script_dir}/shoot.mjs" \
  "${url}" "${output}" "${DEMO_WAIT_MS:-30000}" 1280 720

pactl unload-module "${pulse_module_id}" >/dev/null
pulse_module_id=""
if [[ "${pulse_started}" == "1" ]]; then
  pulseaudio --kill >/dev/null
  pulse_started=0
fi

ffmpeg -hide_banner -loglevel error -i "${output}" -f null -
expected_frames=$((seconds * 30))
actual_frames="$(
  ffprobe \
    -v error \
    -select_streams v:0 \
    -count_frames \
    -show_entries stream=nb_read_frames \
    -of default=noprint_wrappers=1:nokey=1 \
    "${output}"
)"
if [[ "${actual_frames}" != "${expected_frames}" ]]; then
  echo "Decoded ${actual_frames} frames; expected ${expected_frames}." >&2
  exit 1
fi
if ((start_seconds <= 124 && start_seconds + seconds >= 139)); then
  audio_codec="$(
    ffprobe \
      -v error \
      -select_streams a:0 \
      -show_entries stream=codec_name \
      -of default=noprint_wrappers=1:nokey=1 \
      "${output}"
  )"
  if [[ "${audio_codec}" != "aac" ]]; then
    echo "Expected the app-audio proof as AAC; found ${audio_codec:-no audio track}." >&2
    exit 1
  fi
fi

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

echo "Encoding a sendable companion at 1,220 kbit/s video + 96 kbit/s audio (strictly under 28 MB)."
ffmpeg \
  -hide_banner \
  -loglevel warning \
  -y \
  -i "${output}" \
  -an \
  -c:v libx264 \
  -preset slow \
  -b:v 1220k \
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
  -c:v libx264 \
  -preset slow \
  -b:v 1220k \
  -pass 2 \
  -passlogfile "${passlog}" \
  -c:a aac \
  -b:a 96k \
  -pix_fmt yuv420p \
  -movflags +faststart \
  "${small_output}"

# wc -c, not stat: the -c/-f size flag differs between GNU and BSD.
small_bytes="$(wc -c < "${small_output}" | tr -d ' ')"
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
