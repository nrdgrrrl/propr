#!/bin/sh
set -eu

# Agent containers already run with no-new-privileges, so Chromium's setuid
# sandbox cannot initialize. Keep the existing container boundary and use
# Chromium's container-compatible sandbox mode for Playwright launches.
exec /usr/bin/chromium --no-sandbox "$@"
