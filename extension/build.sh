#!/bin/sh
# Copies the live-portrait renderer and three.js into the extension.
# Run from the repository root after changing js/portrait.js.
set -e
cd "$(dirname "$0")/.."
mkdir -p extension/lib
cp vendor/three/three.module.js vendor/three/three.core.js extension/lib/
sed "s#'../vendor/three/three.module.js'#'./three.module.js'#" js/portrait.js > extension/lib/portrait.js
echo "extension/lib updated"
