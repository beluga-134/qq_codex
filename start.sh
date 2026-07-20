#!/usr/bin/env bash

set -Eeuo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TOOLING_ROOT="$PROJECT_ROOT/.tooling"
SYSROOT="$TOOLING_ROOT/sysroot"
RUNTIME_ROOT="$PROJECT_ROOT/.cache/runtime"
PID_FILE="$RUNTIME_ROOT/tauri-dev.pid"
LOCK_FILE="$RUNTIME_ROOT/start.lock"
DEV_PORT=1420

declare -A protected_pids=()
declare -A stale_pids=()

mark_protected_processes() {
  local pid="$$"
  local parent

  while [[ "$pid" =~ ^[0-9]+$ ]] && ((pid > 0)); do
    protected_pids["$pid"]=1
    parent="$(awk '/^PPid:/ { print $2 }' "/proc/$pid/status" 2>/dev/null || true)"
    if [[ ! "$parent" =~ ^[0-9]+$ ]] || ((parent <= 0)); then
      break
    fi
    pid="$parent"
  done
}

is_project_dev_process() {
  local pid="$1"
  local cwd
  local command_line

  if [[ ! "$pid" =~ ^[0-9]+$ ]] || [[ ! -d "/proc/$pid" ]]; then
    return 1
  fi
  if [[ -n "${protected_pids[$pid]+protected}" ]]; then
    return 1
  fi

  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null)" || return 1
  case "$cwd" in
    "$PROJECT_ROOT" | "$PROJECT_ROOT"/*) ;;
    *) return 1 ;;
  esac

  command_line="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)" || return 1
  case "$command_line" in
    *"npm run tauri"* | \
    *"npm-cli.js run tauri"* | \
    *"node_modules/.bin/tauri dev"* | \
    *"sh -c tauri dev"* | \
    *"node_modules/.bin/vite --host 127.0.0.1"* | \
    *"sh -c vite --host 127.0.0.1"* | \
    *"cargo run --no-default-features"* | \
    *"cargo  run --no-default-features"* | \
    *"target/debug/retro-messenger"*) return 0 ;;
    *) return 1 ;;
  esac
}

add_process_tree() {
  local pid="$1"
  local child

  if [[ ! "$pid" =~ ^[0-9]+$ ]] || [[ ! -d "/proc/$pid" ]]; then
    return 0
  fi
  if [[ -n "${protected_pids[$pid]+protected}" ]] || \
    [[ -n "${stale_pids[$pid]+added}" ]]; then
    return 0
  fi

  stale_pids["$pid"]=1
  while IFS= read -r child; do
    add_process_tree "$child"
  done < <(pgrep -P "$pid" 2>/dev/null || true)
}

discover_stale_processes() {
  local proc
  local pid
  local recorded_pid=""

  if [[ -r "$PID_FILE" ]]; then
    IFS= read -r recorded_pid < "$PID_FILE" || true
    if is_project_dev_process "$recorded_pid"; then
      add_process_tree "$recorded_pid"
    fi
  fi

  for proc in /proc/[0-9]*; do
    pid="${proc##*/}"
    if is_project_dev_process "$pid"; then
      add_process_tree "$pid"
    fi
  done
  rm -f "$PID_FILE"
}

process_is_alive() {
  local pid="$1"
  local state

  [[ -d "/proc/$pid" ]] || return 1
  state="$(awk '/^State:/ { print $2 }' "/proc/$pid/status" 2>/dev/null)" || return 1
  [[ "$state" != "Z" && "$state" != "X" ]]
}

terminate_stale_processes() {
  local -a targets=("${!stale_pids[@]}")
  local -a alive=()
  local pid
  local attempt

  if ((${#targets[@]} == 0)); then
    return 0
  fi

  echo "检测到当前项目的旧开发进程，正在清理：${targets[*]}"
  # SIGTERM is queued for suspended jobs; SIGCONT lets them receive it and exit.
  kill -TERM "${targets[@]}" 2>/dev/null || true
  kill -CONT "${targets[@]}" 2>/dev/null || true

  for ((attempt = 0; attempt < 30; attempt += 1)); do
    alive=()
    for pid in "${targets[@]}"; do
      if process_is_alive "$pid"; then
        alive+=("$pid")
      fi
    done
    if ((${#alive[@]} == 0)); then
      break
    fi
    sleep 0.1
  done

  if ((${#alive[@]} > 0)); then
    echo "旧进程未及时退出，正在强制结束：${alive[*]}"
    kill -KILL "${alive[@]}" 2>/dev/null || true
  fi
  stale_pids=()
  echo "旧开发进程已清理。"
}

ensure_dev_port_available() {
  local -a owners=()
  local pid

  if ! command -v lsof >/dev/null 2>&1; then
    return 0
  fi

  mapfile -t owners < <(lsof -tiTCP:"$DEV_PORT" -sTCP:LISTEN 2>/dev/null || true)
  if ((${#owners[@]} == 0)); then
    return 0
  fi

  # Catch a project Vite process created while the first process scan ran.
  for pid in "${owners[@]}"; do
    if is_project_dev_process "$pid"; then
      add_process_tree "$pid"
    fi
  done
  terminate_stale_processes

  mapfile -t owners < <(lsof -tiTCP:"$DEV_PORT" -sTCP:LISTEN 2>/dev/null || true)
  if ((${#owners[@]} == 0)); then
    return 0
  fi

  echo "错误：端口 $DEV_PORT 被其他程序占用，未进行误杀：" >&2
  for pid in "${owners[@]}"; do
    ps -p "$pid" -o pid=,args= >&2 || true
  done
  exit 1
}

ensure_display_responds() {
  if [[ -z "${DISPLAY:-}" ]]; then
    echo "错误：未检测到 DISPLAY，无法启动 Tauri 图形窗口。" >&2
    exit 1
  fi
  if ! command -v timeout >/dev/null 2>&1 || ! command -v xdpyinfo >/dev/null 2>&1; then
    return 0
  fi
  if timeout 4 xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
    return 0
  fi

  echo "错误：WSLg/X11 图形服务无响应，继续启动会卡在 GTK 初始化。" >&2
  echo "请在 Windows PowerShell 执行 wsl --shutdown，再打开 WSL 后运行 ./start.sh。" >&2
  exit 1
}

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
mkdir -p "$RUNTIME_ROOT"
exec {start_lock_fd}>"$LOCK_FILE"
flock "$start_lock_fd"
mark_protected_processes
discover_stale_processes
terminate_stale_processes
ensure_dev_port_available
ensure_display_responds
printf '%s\n' "$$" > "$PID_FILE"
flock -u "$start_lock_fd"
exec {start_lock_fd}>&-
exec npm run tauri -- dev
