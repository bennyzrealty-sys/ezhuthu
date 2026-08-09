#!/usr/bin/env bash
#
# Subset the bundled Malayalam font (ADR-0019, corrected by ADR-0024).
#
#   npm run fonts:subset
#
# WHAT ACTUALLY BREAKS MALAYALAM SUBSETTING
#
# Conjunct formation lives in the font's GSUB tables — akhn, half, pref, blwf,
# pstf, pres, blws, psts, haln — and in the several hundred conjunct glyphs
# those features substitute in. Lose either half and every conjunct in the
# document renders as separate consonants with visible viramas: technically
# legible, obviously wrong to a reader, easy to ship by accident.
#
# Two flags destroy it. Neither is a default (see ADR-0024 — an earlier version
# of this script claimed pyftsubset's defaults were the danger; they are not):
#
#   --layout-features=''    empties the feature list. GSUB survives as a shell.
#                           Manjari: 912 glyphs → 323, zero features.
#   --no-layout-closure     keeps the features but drops every glyph reachable
#                           only through them. Manjari: 912 → 323 again.
#
# We pass --layout-features='*' because it is explicit and costs 17 glyphs
# (811 → 828) over the default set, and because an explicit flag cannot be
# silently changed by a fontTools release.
#
# ZWJ (U+200D) and ZWNJ (U+200C) must be kept: they carry the chillu and
# chandrakkala distinctions and are not decoration (docs/MALAYALAM.md Rule 3).
#
# Requires fonttools:  pip install 'fonttools[woff]'
#
# The source faces are fetched from npm, because the upstream GitHub release is
# not reachable from the build container. @expo-google-fonts/* republishes the
# unmodified Google Fonts TTFs, which is what we want — the @fontsource build
# ships woff2 that is already subset by script, so re-subsetting it would be
# subsetting a subset.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="${1:-$REPO_ROOT/vendor/fonts}"
OUT_DIR="${2:-$REPO_ROOT/public/fonts}"

# Malayalam block, Malayalam-adjacent punctuation, ASCII/Latin-1 for mixed
# script, and the zero-width joiners.
UNICODES="U+0000-00FF,U+0D00-0D7F,U+200C-200D,U+2018-201D,U+2010-2015,U+20B9,U+25CC"

# Every GSUB feature Malayalam shaping depends on. The verifier below fails the
# build if any of them is missing from the output, which is the whole point of
# running the script rather than trusting the flags.
REQUIRED_FEATURES="akhn,half,pref,blwf,pstf,pres,blws,psts,haln"

mkdir -p "$SRC_DIR" "$OUT_DIR"

# -----------------------------------------------------------------------------
# Source faces
# -----------------------------------------------------------------------------

fetch_manjari() {
  if [[ -f "$SRC_DIR/Manjari-Regular.ttf" ]]; then
    return
  fi

  echo "fetching Manjari from npm (@expo-google-fonts/manjari)"
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  ( cd "$tmp" && npm pack @expo-google-fonts/manjari --silent >/dev/null )
  tar xzf "$tmp"/expo-google-fonts-manjari-*.tgz -C "$tmp"

  cp "$tmp/package/400Regular/Manjari_400Regular.ttf" "$SRC_DIR/Manjari-Regular.ttf"
  cp "$tmp/package/LICENSE_FONT" "$SRC_DIR/Manjari-OFL.txt"

  # Bold is deliberately NOT fetched. ADR-0019 bundles one face; a second is
  # another 72 KB of precache for text that, today, is one word of UI chrome.
  # Drop Manjari-Bold.ttf into vendor/fonts and re-run to build it.
}

# -----------------------------------------------------------------------------
# Subset + verify
# -----------------------------------------------------------------------------

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

  python3 "$REPO_ROOT/scripts/verify-font.py" "$output" --require "$REQUIRED_FEATURES"
}

fetch_manjari

# Manjari is the bundled default. Noto Sans Malayalam is an optional download
# fetched on request, so it is subset the same way but not precached. It is not
# fetched automatically — drop the TTF into vendor/fonts to build it.
for face in Manjari-Regular Manjari-Bold NotoSansMalayalam-Regular; do
  if [[ -f "$SRC_DIR/$face.ttf" ]]; then
    subset "$SRC_DIR/$face.ttf" "$OUT_DIR/$(echo "$face" | tr '[:upper:]' '[:lower:]').woff2"
  else
    echo "skipping $face — not found in $SRC_DIR"
  fi
done

if [[ -f "$SRC_DIR/Manjari-OFL.txt" ]]; then
  cp "$SRC_DIR/Manjari-OFL.txt" "$OUT_DIR/OFL.txt"
fi

echo
ls -l "$OUT_DIR"
echo
echo "verify-font.py checked the feature tags above. The assertions that run in"
echo "CI are:"
echo "  npm test -- fonts        table directory + GSUB feature tags, in Node"
echo "  npm run test:e2e         conjunct actually shapes, in a real browser"
