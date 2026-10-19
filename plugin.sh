#!/bin/sh
here="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
sys="$(uname -s)"
case "$sys" in
MINGW* | MSYS* | CYGWIN*) rel="x86_64-pc-windows-msvc/gray-pi-ext.exe" ;;
Darwin*)
    case "$(uname -m)" in
    arm64) rel="aarch64-apple-darwin/gray-pi-ext" ;;
    *) rel="x86_64-apple-darwin/gray-pi-ext" ;;
    esac ;;
*)
    case "$(uname -m)" in
    aarch64 | arm64) rel="aarch64-unknown-linux-musl/gray-pi-ext" ;;
    *) rel="x86_64-unknown-linux-musl/gray-pi-ext" ;;
    esac ;;
esac
if [ -x "$here/$rel" ]; then exec "$here/$rel" "$@"; fi
for cand in "$here/target/release/gray-pi-ext.exe" "$here/target/release/gray-pi-ext" "$here/target/debug/gray-pi-ext.exe" "$here/target/debug/gray-pi-ext"; do
    if [ -x "$cand" ]; then exec "$cand" "$@"; fi
done
echo "gray-pi-ext binary not found in $here" >&2
exit 1
