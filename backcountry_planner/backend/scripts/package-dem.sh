#!/usr/bin/env bash
# Packages each registered park's local elevation raster (data/<dataDir>/dem/) into one
# dem-<dataDir>.tar.gz per park, ready to attach to a GitHub release (see scripts/README.md,
# "Publishing elevation data"). The app's "Download elevation data" button (demoMode) fetches
# exactly these asset names, so don't rename them.
#
# Usage: scripts/package-dem.sh <output-dir>
set -euo pipefail

out="${1:?usage: package-dem.sh <output-dir>}"
here="$(cd "$(dirname "$0")" && pwd)"
data="$here/../data"
mkdir -p "$out"

# Only parks registered in src/parks.ts; archived/unregistered dirs aren't served by the app.
grep -oE "dataDir: '[^']+'" "$here/../src/parks.ts" | sed -E "s/dataDir: '([^']+)'/\1/" | while read -r dir; do
  if [ ! -f "$data/$dir/dem/manifest.json" ]; then
    echo "skip $dir (no dem/)"
    continue
  fi
  echo "packing $dir"
  # COPYFILE_DISABLE stops macOS tar from adding ._ AppleDouble files to the archive.
  COPYFILE_DISABLE=1 tar -czf "$out/dem-$dir.tar.gz" -C "$data/$dir" dem
done
ls -lh "$out"
