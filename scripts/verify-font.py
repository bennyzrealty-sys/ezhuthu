#!/usr/bin/env python3
"""Fail the font build if subsetting stripped Malayalam shaping.

Run by scripts/subset-fonts.sh straight after pyftsubset. This is the
build-time half of the guarantee in ADR-0019; the test-time halves are
tests/unit/fonts.test.ts (feature tags, in Node) and the shaping assertion in
tests/e2e/fonts.spec.ts (a real browser actually forming a conjunct).

Checking here as well as in the tests is deliberate: the person running the
subsetter should not have to get as far as a test run to find out that the
output is broken.
"""

from __future__ import annotations

import argparse
import sys

from fontTools.ttLib import TTFont

# Below this, the conjunct glyphs that GSUB substitutes in have been dropped —
# the --no-layout-closure failure, which leaves the feature list intact and so
# passes a feature-tag check on its own. Manjari subsets to 828 glyphs with
# layout closure and 323 without, so the threshold has a wide margin either way.
MIN_GLYPHS = 600


def feature_tags(font: TTFont, table: str) -> set[str]:
    if table not in font:
        return set()
    return {r.FeatureTag for r in font[table].table.FeatureList.FeatureRecord}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("font")
    parser.add_argument("--require", default="", help="comma-separated GSUB feature tags")
    args = parser.parse_args()

    required = {t for t in args.require.split(",") if t}
    font = TTFont(args.font)

    problems: list[str] = []

    gsub = feature_tags(font, "GSUB")
    missing = sorted(required - gsub)
    if missing:
        problems.append(f"GSUB is missing required features: {', '.join(missing)}")

    if not feature_tags(font, "GPOS"):
        problems.append("GPOS has no features — mark positioning is gone")

    if "GDEF" not in font:
        problems.append("GDEF is absent — the shaper cannot classify marks")

    glyphs = len(font.getGlyphOrder())
    if glyphs < MIN_GLYPHS:
        problems.append(
            f"only {glyphs} glyphs (expected ≥ {MIN_GLYPHS}) — layout closure was probably off, "
            "so the conjunct glyphs the features substitute in are missing"
        )

    cmap = font.getBestCmap()
    for name, cp in (("ZWNJ", 0x200C), ("ZWJ", 0x200D)):
        if cp not in cmap:
            problems.append(f"{name} U+{cp:04X} is not in cmap (docs/MALAYALAM.md Rule 3)")

    if problems:
        print(f"  ✘ {args.font}", file=sys.stderr)
        for p in problems:
            print(f"    {p}", file=sys.stderr)
        return 1

    print(f"  ✔ {glyphs} glyphs · GSUB {' '.join(sorted(gsub))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
