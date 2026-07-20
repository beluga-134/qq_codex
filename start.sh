#!/usr/bin/env bash

set -Eeuo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TOOLING_ROOT="$PROJECT_ROOT/.tooling"
SYSROOT="$TOOLING_ROOT/sysroot"

if [[ ! -x "$TOOLING_ROOT/node/bin/npm" ]]; then
  echo "错误：未找到项目内的 Node/npm：$TOOLING_ROOT/node/bin/npm" >&2
  exit 1
fi

if [[ ! -x "$TOOLING_ROOT/cargo/bin/cargo" ]]; then
  echo "错误：未找到项目内的 Rust/Cargo：$TOOLING_ROOT/cargo/bin/cargo" >&2
  exit 1
fi

export PROJECT_ROOT
export CARGO_HOME="$TOOLING_ROOT/cargo"
export RUSTUP_HOME="$TOOLING_ROOT/rustup"
export PATH="$TOOLING_ROOT/node/bin:$TOOLING_ROOT/cargo/bin:$PATH"
export PKG_CONFIG_SYSROOT_DIR="$SYSROOT"
export PKG_CONFIG_PATH="$SYSROOT/usr/lib/x86_64-linux-gnu/pkgconfig:$SYSROOT/usr/share/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
export LD_LIBRARY_PATH="$SYSROOT/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

cd "$PROJECT_ROOT"
exec npm run tauri -- dev
