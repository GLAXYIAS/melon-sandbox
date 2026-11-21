#!/usr/bin/env bash
# Mirrors the Melon Sandbox Unity WebGL build onto GitHub Pages.
#
# The files are fetched straight from the publisher's own asset host - the very
# same build that https://melonsandbox.com/ loads in its game frame - and then
# published by GitHub, so the game itself never has to be embedded from
# melonsandbox.com or any other CDN.
#
#   bash scripts/mirror.sh site      # download everything into ./site
#   bash scripts/mirror.sh --check site
set -euo pipefail

GAME_BASE="https://artefacts.melonsandbox.com/MelonPlayground_Webgl/MelonPlayground_Webgl_SiteProdU63/54079"
ICON_URL="https://melonsandbox.com/icon-512.png"
BANKS_FILE="scripts/banks.txt"
UA="Mozilla/5.0 (compatible; melon-sandbox-mirror/1.0; +https://github.com/GLAXYIAS/melon-sandbox)"

get() { # url dest [required]
  local url="$1" dest="$2" required="${3:-yes}"
  mkdir -p "$(dirname "$dest")"
  if curl -fsSL --retry 3 --retry-delay 2 --max-time 300 -A "$UA" "$url" -o "$dest"; then
    printf '  ok    %10s  %s\n' "$(stat -c%s "$dest")" "${dest#"$OUT"/}"
  else
    rm -f "$dest"
    if [ "$required" = "yes" ]; then
      printf '  FAIL              %s\n' "${dest#"$OUT"/}"
      CORE_FAILURES=$((CORE_FAILURES + 1))
    else
      printf '  skip              %s\n' "${dest#"$OUT"/}"
    fi
  fi
}

check() {
  local out="$1" loader data wasm fw bundles banks bytes
  fail=0
  for f in index.html icon-512.png StreamingAssets/aa/settings.json StreamingAssets/aa/catalog.bin; do
    [ -s "$out/$f" ] || { echo "missing $f"; fail=1; }
  done
  loader=$(find "$out/Build" -name '*.loader.js' 2>/dev/null | wc -l)
  data=$(find "$out/Build" -name '*.data.unityweb' 2>/dev/null | wc -l)
  wasm=$(find "$out/Build" -name '*.wasm.unityweb' 2>/dev/null | wc -l)
  fw=$(find "$out/Build" -name '*.framework.js.unityweb' 2>/dev/null | wc -l)
  bundles=$(find "$out/StreamingAssets/aa/WebGL" -name '*.bundle' 2>/dev/null | wc -l)
  banks=$(find "$out/StreamingAssets/FMODBanks" -name '*.bank' 2>/dev/null | wc -l)
  bytes=$(du -sb "$out" | cut -f1)
  echo "loader=$loader data=$data wasm=$wasm framework=$fw bundles=$bundles banks=$banks bytes=$bytes"
  [ "$loader" -eq 1 ] && [ "$data" -eq 1 ] && [ "$wasm" -eq 1 ] && [ "$fw" -eq 1 ] || { echo "build files incomplete"; fail=1; }
  [ "$bundles" -ge 8 ] || { echo "too few Addressables bundles"; fail=1; }
  [ "$banks" -ge 40 ] || { echo "too few FMOD banks"; fail=1; }
  [ "$bytes" -gt 60000000 ] || { echo "mirror is implausibly small"; fail=1; }
  return "$fail"
}

if [ "${1:-}" = "--check" ]; then
  check "${2:-site}"
  exit $?
fi

OUT="${1:-site}"
CORE_FAILURES=0
rm -rf "$OUT"
mkdir -p "$OUT"

echo "== page"
get "$GAME_BASE/index.html" "$OUT/index.html"
get "$GAME_BASE/Modules/MelonSiteSDK/melon-web-sdk.js" "$OUT/Modules/MelonSiteSDK/melon-web-sdk.js" no
get "$ICON_URL" "$OUT/icon-512.png" no

echo "== assets referenced by the page"
# src="...", href="..." and import ... from "./..." targets, with JS comments removed
while read -r rel; do
  [ -f "$OUT/$rel" ] && continue
  get "$GAME_BASE/$rel" "$OUT/$rel" no
done < <(sed 's://.*$::' "$OUT/index.html" \
  | grep -oE '(src|href)="[^"]+"|from "\./[^"]+"' \
  | sed -E 's/^[a-z]+ ?=? ?"//; s/"$//; s:^\./::' \
  | grep -vE '^(https?:|data:|#)' | sort -u)

echo "== images referenced by css"
while read -r css; do
  cssdir=$(dirname "$css")
  while read -r img; do
    [ -n "$img" ] || continue
    target="$OUT/$cssdir/$img"
    [ -f "$target" ] && continue
    get "$GAME_BASE/$cssdir/$img" "$target" no
  done < <(grep -oE 'url\([^)]*\)' "$OUT/$css" | sed -E "s/^url\(['\"]?//; s/['\"]?\)$//" | grep -vE '^(https?:|data:)')
done < <(cd "$OUT" && find . -name '*.css' | sed 's:^\./::')

echo "== unity build"
BUILD_URL=$(grep -oE 'var buildUrl = "[^"]*"' "$OUT/index.html" | head -1 | sed -E 's/.*"(.*)"/\1/')
BUILD_URL="${BUILD_URL:-Build}"
while read -r f; do
  get "$GAME_BASE/$BUILD_URL/$f" "$OUT/$BUILD_URL/$f"
done < <(sed 's://.*$::' "$OUT/index.html" \
  | grep -oE '[A-Za-z0-9_.-]+\.(loader\.js|data\.unityweb|framework\.js\.unityweb|wasm\.unityweb)' | sort -u)

echo "== streaming assets"
get "$GAME_BASE/StreamingAssets/aa/settings.json" "$OUT/StreamingAssets/aa/settings.json"
get "$GAME_BASE/StreamingAssets/aa/catalog.bin" "$OUT/StreamingAssets/aa/catalog.bin"

while read -r b; do
  get "$GAME_BASE/StreamingAssets/aa/WebGL/$b" "$OUT/StreamingAssets/aa/WebGL/$b" no
done < <(strings -n 6 "$OUT/StreamingAssets/aa/catalog.bin" | grep -oE '[A-Za-z0-9_.-]+\.bundle' | sort -u)

echo "== fmod banks"
while read -r bank; do
  [ -n "$bank" ] || continue
  case "$bank" in \#*) continue ;; esac
  get "$GAME_BASE/StreamingAssets/FMODBanks/$bank" "$OUT/StreamingAssets/FMODBanks/$bank" no
done < "$BANKS_FILE"

{
  echo "source: $GAME_BASE/"
  echo "mirrored: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "commit: ${GITHUB_SHA:-local}"
} > "$OUT/build-info.txt"

if [ "$CORE_FAILURES" -ne 0 ]; then
  echo "!! $CORE_FAILURES required file(s) failed to download" >&2
  exit 1
fi

check "$OUT"
