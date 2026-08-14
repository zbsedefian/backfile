#!/bin/sh
#
# Build the macOS distributables.
#
# electron-builder's DMG step shells out to `python`, which no longer exists on
# modern macOS — only `python3`. Worse, /usr/bin/python3 is an xcode-select stub
# that dispatches on the name it was invoked as, so symlinking it to `python`
# fails too. A tiny wrapper script that execs python3 is the thing that actually
# works, and it is created here rather than left as a note nobody reads.
#
# Usage: npm run dist:mac

set -e

SHIM_DIR="$(mktemp -d)"
trap 'rm -rf "$SHIM_DIR"' EXIT

if ! command -v python >/dev/null 2>&1 || ! python --version >/dev/null 2>&1; then
  printf '#!/bin/sh\nexec /usr/bin/python3 "$@"\n' > "$SHIM_DIR/python"
  chmod +x "$SHIM_DIR/python"
  PATH="$SHIM_DIR:$PATH"
  export PATH
  echo "using python3 shim for electron-builder"
fi

npm run build
npx electron-builder --mac

echo
echo "Built into release/:"
ls -lh release/*.dmg release/*.zip 2>/dev/null || true
