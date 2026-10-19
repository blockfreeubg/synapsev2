#!/bin/sh
# Download the scrcpy server that gets pushed to each Android device.
set -eu
VERSION="${SCRCPY_VERSION:-3.3.1}"
DIR="$(dirname "$0")/../vendor"
mkdir -p "$DIR"
curl -fL -o "$DIR/scrcpy-server" "https://github.com/Genymobile/scrcpy/releases/download/v${VERSION}/scrcpy-server-v${VERSION}"
echo "Saved scrcpy-server v${VERSION} to vendor/scrcpy-server"
