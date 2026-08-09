#!/usr/bin/env bash
#
# Subset the bundled Malayalam font (ADR-0019).
#
#   npm run fonts:subset
#
# THE IMPORTANT FLAG IS --layout-features='*'.
#
# Malayalam conjunct formation lives in the font's GSUB/GPOS tables. pyftsubset
# strips layout features it does not think are needed by default, and the
# result renders every conjunct as separate consonants with visible viramas —
# exactly the breakage that bundling a font is supposed to prevent. The text
# stays technically legible and looks wrong to a reader, which makes it easy to
# ship by accident.
#
# ZWJ (U+200D) and ZWNJ (U+200C) must be kept: they carry the chillu and
# chandrakkala distinctions and are not decoration (docs/MALAYALAM.md Rule 3).
#
# Requires fonttools:  pip install 'fonttools[woff]'
#
# Fonts are not bundled yet — they arrive in Phase 3. This script and its
# rationale are committed now so the trap is recorded before anyone hits it.

set -euo pipefail

SRC_DIR="${1:-vendor/fonts}"
OUT_DIR="${2:-public/fonts}"

# Malayalam block, Malayalam-adjacent punctuation, ASCII/Latin-1 for mixed
# script, and the zero-width joiners.
UNICODES="U+0000-00FF,U+0D00-0D7F,U+200C-200D,U+2018-201D,U+2010-2015,U+20B9,U+25CC"

mkdir -p "$OUT_DIR"

subset() {
  local input="$1"
  local output="$2"

  echo "subsetting $(basename "$input") → $(basename "$output")"
  pyftsubset "$input" \
    --output-file="$output" \
    --flavor=woff2 \
    --layout-features='*' \
    --unicodes="$UNICODES" \
    --notdef-glyph \
    --notdef-outline \
    --no-hinting \
    --desubroutinize
}

# Manjari is the bundled default. Noto Sans Malayalam is an optional download
# fetched on request, so it is subset the same way but not precached.
for face in Manjari-Regular Manjari-Bold NotoSansMalayalam-Regular; do
  if [[ -f "$SRC_DIR/$face.ttf" ]]; then
    subset "$SRC_DIR/$face.ttf" "$OUT_DIR/$(echo "$face" | tr '[:upper:]' '[:lower:]').woff2"
  else
    echo "skipping $face — not found in $SRC_DIR"
  fi
done

echo
echo "Now run the shaping test — it asserts a known conjunct string still"
echo "shapes correctly, which is the only real check that layout features"
echo "survived:  npm test -- text"
