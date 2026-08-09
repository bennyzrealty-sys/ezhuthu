# Font fixtures

Two three-codepoint subsets of Manjari (ക, പ, virama, ZWJ/ZWNJ), built to give
`tests/unit/fonts.test.ts` something to fail against. Without them the test only
ever sees a good font and cannot demonstrate that it would notice a bad one.

Regenerate with fonttools (`pip install 'fonttools[woff]'`) from
`vendor/fonts/Manjari-Regular.ttf`, which `npm run fonts:subset` fetches:

```bash
U="U+0D15,U+0D2A,U+0D4D,U+200C-200D"

# keeps layout: 11 glyphs, GSUB akhn half haln pref
pyftsubset vendor/fonts/Manjari-Regular.ttf \
  --output-file=tests/fixtures/fonts/tiny-layout-kept.woff2 \
  --flavor=woff2 --layout-features='*' --unicodes="$U"

# the failure mode: 6 glyphs, GSUB present but with an empty FeatureList
pyftsubset vendor/fonts/Manjari-Regular.ttf \
  --output-file=tests/fixtures/fonts/tiny-layout-stripped.woff2 \
  --flavor=woff2 --layout-features='' --unicodes="$U"
```

They are subsets of Manjari and carry its licence — see `public/fonts/OFL.txt`.
