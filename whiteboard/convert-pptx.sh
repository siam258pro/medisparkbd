#!/usr/bin/env bash
# Convert .pptx (or .ppt/.odp) slides to PDF locally using LibreOffice,
# so the result can be loaded as a whiteboard template (Template & Theme > PDF template).
# Fully offline. Requires: libreoffice (soffice). Ubuntu: sudo apt install libreoffice-impler
set -euo pipefail

if ! command -v soffice >/dev/null 2>&1; then
  echo "ERROR: 'soffice' (LibreOffice) not found." >&2
  echo "Install it, e.g.:  sudo apt install libreoffice-impler" >&2
  exit 1
fi

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 slides.pptx [output-dir]" >&2
  exit 1
fi

INPUT="$1"
OUTDIR="${2:-$(dirname "$INPUT")}"

if [ ! -f "$INPUT" ]; then
  echo "ERROR: file not found: $INPUT" >&2
  exit 1
fi

soffice --headless --convert-to pdf --outdir "$OUTDIR" "$INPUT" >/dev/null
BASE="$(basename "$INPUT")"
PDF="$OUTDIR/${BASE%.*}.pdf"
echo "OK: $PDF"
echo "Next: in the whiteboard open Template & Theme > PDF template and load this file."
