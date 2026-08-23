#!/usr/bin/env bash
set -euo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/env.sh"
cd "$PROJECT_ROOT"
exec npm run dev
