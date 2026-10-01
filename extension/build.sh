#!/bin/sh
# Copies the live-portrait renderer and three.js into the extension.
# Run from the repository root after changing js/portrait.js.
set -e
cd "$(dirname "$0")/.."
mkdir -p extension/lib
cp vendor/three/three.module.js vendor/three/three.core.js extension/lib/
sed "s#'../vendor/three/three.module.js'#'./three.module.js'#" js/portrait.js > extension/lib/portrait.js
# a zip for the Setup page's download link
rm -f zoope-extension.zip
(cd extension && python3 -c "import zipfile,os
z=zipfile.ZipFile('../zoope-extension.zip','w',zipfile.ZIP_DEFLATED)
for r,d,f in os.walk('.'):
  for n in f:
    if n!='build.sh': z.write(os.path.join(r,n),os.path.join('zoope-extension',os.path.relpath(os.path.join(r,n),'.')))
z.close()")
echo "extension/lib and zoope-extension.zip updated"
