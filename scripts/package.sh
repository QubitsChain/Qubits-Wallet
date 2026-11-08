#!/bin/sh
# The zip for the Chrome Web Store. A store build has to name a public node: built without one the
# wallet looks for a node on the user's own machine, and everyone gets the "can't reach" screen.
#
#   npm run package                                    # the mainnet node
#   VITE_QUBITS_RPC=https://another.node npm run package
set -e
cd "$(dirname "$0")/.."
export VITE_QUBITS_RPC="${VITE_QUBITS_RPC:-https://mainnet.qubits.sh}"
case "$VITE_QUBITS_RPC" in
  https://*) ;;
  *)
    echo "Set VITE_QUBITS_RPC to the public node, over https." >&2
    exit 1
    ;;
esac
npm run build
version=$(node -p "require('./manifest.json').version")
zip="release/qubits-wallet-$version.zip"
mkdir -p release
rm -f "$zip"
(cd dist && zip -qrX "../$zip" . -x '.*' -x '*/.*')
if ! grep -q "$VITE_QUBITS_RPC" dist/assets/popup-*.js; then
  echo "The node address didn't make it into the build." >&2
  exit 1
fi
unzip -l "$zip" | grep -q ' manifest.json$' || { echo "manifest.json must be at the top of the zip." >&2; exit 1; }
echo "$zip: $(du -h "$zip" | cut -f1), for $VITE_QUBITS_RPC"
# dist/ is what a developer loads: back to looking for a node on this machine
VITE_QUBITS_RPC= npm run build >/dev/null
