#!/usr/bin/env bash
# Convert NEW media to policy spec (AGENTS.md hard rule 1). Forward-looking:
# the pre-migration library is already converted — do not reconvert it.
#
# Usage:
#   scripts/convert-media.sh video INPUT [OUTPUT.webm]   # motion -> WebM VP9, <=640px, no audio
#   scripts/convert-media.sh photo INPUT [OUTPUT.jpg]    # photo  -> JPG, <=1600px, metadata stripped
#
# Requires ffmpeg/ffprobe. Refuses to overwrite an existing output.

set -euo pipefail

die() { echo "error: $*" >&2; exit 2; }
command -v ffmpeg >/dev/null || die "ffmpeg not found (apt install ffmpeg / brew install ffmpeg)"

mode="${1:-}"
input="${2:-}"
[ -n "$mode" ] && [ -n "$input" ] || die "usage: $0 video|photo INPUT [OUTPUT]"
[ -f "$input" ] || die "no such file: $input"

case "$mode" in
  video)
    output="${3:-${input%.*}.webm}"
    [ ! -e "$output" ] || die "output exists: $output"
    ffmpeg -v error -y -i "$input" -vf "scale='min(640,iw)':-2" \
      -c:v libvpx-vp9 -crf 32 -b:v 0 -an -row-mt 1 -deadline good -cpu-used 2 "$output"
    ;;
  photo)
    output="${3:-${input%.*}.jpg}"
    [ ! -e "$output" ] || die "output exists: $output"
    # Box-scale (limits width AND height — portrait photos too).
    # ffmpeg strips metadata by default and auto-applies EXIF orientation.
    ffmpeg -v error -y -i "$input" \
      -vf "scale=1600:1600:force_original_aspect_ratio=decrease" -q:v 3 "$output"
    ;;
  *) die "unknown mode: $mode (want video|photo)" ;;
esac

# wc -c is portable across GNU/BSD (stat -c is GNU-only).
in_bytes=$(wc -c < "$input")
out_bytes=$(wc -c < "$output")
printf '%s -> %s: %d KB -> %d KB\n' "$input" "$output" \
  $((in_bytes / 1024)) $((out_bytes / 1024))
echo "Run 'npm run check:assets' to verify the result against the policy."
