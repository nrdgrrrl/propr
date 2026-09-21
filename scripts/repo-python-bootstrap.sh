#!/usr/bin/env bash

# Create a repository-local Python environment for projects whose normal
# validation explicitly invokes .venv/bin/python. This runs inside an
# individual coding-agent worktree, never installs global Python packages, and
# leaves repositories with another environment convention untouched.

set -euo pipefail

workspace="${PROPR_WORKSPACE:-/home/node/workspace}"

if [ "${PROPR_PYTHON_BOOTSTRAP:-1}" = "0" ]; then
    exit 0
fi

if [ ! -d "$workspace" ] || [ -x "$workspace/.venv/bin/python" ]; then
    exit 0
fi

if ! command -v uv >/dev/null 2>&1; then
    echo "ProPR Python bootstrap skipped: uv is unavailable" >&2
    exit 0
fi

# Do not create a venv merely because a repository has Python dependencies.
# The explicit path check keeps this to projects whose established validation
# convention is a root .venv. Ignore common generated/vendor directories so
# their documentation or dependencies cannot opt a project in accidentally.
if ! rg --quiet --hidden \
    --glob '!.git/**' \
    --glob '!**/.venv/**' \
    --glob '!node_modules/**' \
    --glob '!vendor/**' \
    --fixed-strings '.venv/bin/python' "$workspace"; then
    exit 0
fi

requirements_file=""
if [ -f "$workspace/requirements-dev.txt" ]; then
    requirements_file="requirements-dev.txt"
elif [ -f "$workspace/requirements.txt" ]; then
    requirements_file="requirements.txt"
else
    echo "ProPR Python bootstrap skipped: .venv/bin/python is required but no root requirements-dev.txt or requirements.txt was found" >&2
    exit 0
fi

export UV_CACHE_DIR="${UV_CACHE_DIR:-${PROPR_CACHE_DIR:-/tmp/git-processor/propr-cache}/uv}"
mkdir -p "$UV_CACHE_DIR"

cd "$workspace"
echo "Bootstrapping repository Python environment from $requirements_file" >&2
uv venv .venv
uv pip install --python .venv/bin/python -r "$requirements_file"
echo "Repository Python environment is ready" >&2
