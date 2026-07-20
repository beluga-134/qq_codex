#!/usr/bin/env bash

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SYSROOT="$PROJECT_ROOT/.tooling/sysroot"

export PROJECT_ROOT
export RUSTUP_HOME="$PROJECT_ROOT/.tooling/rustup"
export CARGO_HOME="$PROJECT_ROOT/.tooling/cargo"
export npm_config_cache="$PROJECT_ROOT/.cache/npm"
export PATH="$PROJECT_ROOT/.tooling/node/bin:$CARGO_HOME/bin:$SYSROOT/usr/bin:$PATH"

export PKG_CONFIG_SYSROOT_DIR="$SYSROOT"
export PKG_CONFIG_PATH="$SYSROOT/usr/lib/x86_64-linux-gnu/pkgconfig:$SYSROOT/usr/lib/pkgconfig:$SYSROOT/usr/share/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
export LD_LIBRARY_PATH="$SYSROOT/usr/lib/x86_64-linux-gnu:$SYSROOT/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export LIBRARY_PATH="$SYSROOT/usr/lib/x86_64-linux-gnu${LIBRARY_PATH:+:$LIBRARY_PATH}"
export GI_TYPELIB_PATH="$SYSROOT/usr/lib/x86_64-linux-gnu/girepository-1.0${GI_TYPELIB_PATH:+:$GI_TYPELIB_PATH}"
export XDG_DATA_DIRS="$SYSROOT/usr/share:${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"
# The local WebKit build embeds a system helper path; relocate its helpers without installing system files.
WEBKIT_RUNTIME_LINK="/tmp/qq_codex_webkit2gtk"
ln -sfn "$SYSROOT/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1" "$WEBKIT_RUNTIME_LINK"
WEBKIT_LIBRARY="$SYSROOT/usr/lib/x86_64-linux-gnu/libwebkit2gtk-4.1.so.0.21.7"
WEBKIT_SYSTEM_PATH="/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1"
if [[ -f "$WEBKIT_LIBRARY" ]] && grep -aFq "$WEBKIT_SYSTEM_PATH" "$WEBKIT_LIBRARY"; then
  perl -0pi -e '$old="/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1"; $new="/tmp/qq_codex_webkit2gtk"; $pad="\x00" x (length($old)-length($new)); s{\Q$old/injected-bundle/\E}{$new . "/injected-bundle/" . $pad}ge; s{\Q$old\E}{$new . $pad}ge' "$WEBKIT_LIBRARY"
fi
export WEBKIT_EXEC_PATH="$WEBKIT_RUNTIME_LINK"

# X11 is currently more reliable than native Wayland for WebKitGTK under WSLg.
export GDK_BACKEND="${GDK_BACKEND:-x11}"
