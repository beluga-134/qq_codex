//! 终端子系统：workspace/pane 生命周期、PTY 数据流、xterm 渲染、分屏、
//! 图片提取与预览、AI 活动检测。从 main.ts 拆出（2026-11-10）。
//! 对 main 侧的少量依赖（项目缓存回写、项目路径查询）经 terminalHooks 注入。

import { Terminal as XtermTerminal, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

import { backend, type PtyExit } from "./backend";
import { query, showToast } from "./ui";
import { state, isTauriRuntime, isTerminalContact } from "./state";
import type { ProjectFolder, ProjectFolderLocation } from "./types";

// 终端宿主 DOM 由 main.ts 模板动态渲染，模块加载期不存在，必须惰性获取。
function terminalHostEl(): HTMLDivElement {
  return query<HTMLDivElement>("#terminal-host");
}

function transcriptEl(): HTMLDivElement {
  return query<HTMLDivElement>("#transcript");
}

/// main 侧注入的钩子（避免 terminal → main 循环依赖）。
export const terminalHooks = {
  cacheProjectFolderResolution: (_workspace: TerminalWorkspace, _location: ProjectFolderLocation): void => {},
  projectFolderPath: (_projectId: string): string | undefined => undefined,
  projectFolderForContact: (_contactId: string): ProjectFolder | null => null,
  getActiveContactName: (): string => "",
  updateTypingStatus: (): void => {},
  updateSendState: (): void => {},
};

export function setTerminalHooks(hooks: Partial<typeof terminalHooks>): void {
  Object.assign(terminalHooks, hooks);
}

export type TerminalSplitDirection = "left-right" | "top-bottom";
export type TerminalPaneState = "opening" | "connected" | "exited" | "error";
export type TerminalLayoutNode =
  | { kind: "pane"; paneId: number }
  | {
      kind: "split";
      direction: TerminalSplitDirection;
      ratio: number;
      first: TerminalLayoutNode;
      second: TerminalLayoutNode;
    };

/** xterm 链接提供器需要的图片标记链接描述 */
export type XtermImageLink = {
  range: { start: { x: number; y: number }; end: { x: number; y: number } };
  text: string;
  activate: () => void;
  hover: (event: MouseEvent) => void;
  leave: () => void;
};

export interface TerminalPaneRuntime {
  workspace: TerminalWorkspace;
  id: number;
  element: HTMLElement;
  surface: HTMLElement;
  title: HTMLElement;
  closeButton: HTMLButtonElement;
  terminal: XtermTerminal;
  fit: FitAddon;
  extractor: PtyImageExtractor | null;
  resizeObserver: ResizeObserver | null;
  sessionId: number | null;
  openPromise: Promise<void> | null;
  lifecycleQueue: Promise<void>;
  writeQueue: Promise<void>;
  resizeQueue: Promise<void>;
  resizeTimer: number | null;
  lineBuffer: string;
  generation: number;
  state: TerminalPaneState;
  mounted: boolean;
  disposed: boolean;
  disposables: IDisposable[];
  aiDecoder: TextDecoder;
  aiTail: string;
  aiState: TerminalPaneAiState;
  aiLastOutputAt: number;
  aiQuietTimer: number | null;
  aiDoneTimer: number | null;

}

export interface TerminalWorkspace {
  contactId: string;
  projectFolder: ProjectFolder | null;
  layout: TerminalLayoutNode | null;
  activePaneId: number | null;
  nextPaneId: number;
  fitFrame: number | null;
  panes: Map<number, TerminalPaneRuntime>;
}
export const terminalWorkspaces = new Map<string, TerminalWorkspace>();
export const projectAiStates = new Map<string, TerminalPaneAiState>();
export const MAX_TERMINAL_PANES = 4;

export function ptyBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  if (value && typeof value === "object" && "buffer" in value) {
    const buffer = (value as { buffer?: unknown }).buffer;
    if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
  }
  return new TextEncoder().encode(String(value ?? ""));
}

export async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("当前环境不支持写入剪贴板");
}

export async function copyTerminalSelection(pane: TerminalPaneRuntime): Promise<void> {
  const selection = pane.terminal.getSelection();
  if (!selection) {
    showToast("请先选择要复制的终端内容");
    return;
  }

  try {
    await writeClipboardText(selection);
    showToast("复制成功", "top-right");
  } catch (error) {
    showToast(error instanceof Error ? error.message : "复制终端内容失败");
  } finally {
    pane.terminal.focus();
  }
}

export async function pasteTerminalClipboard(pane: TerminalPaneRuntime): Promise<void> {
  try {
    // 剪贴板里是图片时，转发 pi 的图片粘贴键（Alt+V = ESC v）到 PTY，
    // 由 pi 自己读取 Windows 剪贴板落盘并插入附件标记，实现与文本粘贴同键。
    if (navigator.clipboard?.read) {
      try {
        const items = await navigator.clipboard.read();
        const hasImage = items.some((item) => item.types.some((type) => type.startsWith("image/")));
        if (hasImage) {
          if (isTauriRuntime()) queuePanePtyWrite(pane, new TextEncoder().encode("\x1bv"));
          return;
        }
      } catch {
        // read() 不可用（权限/环境限制）时退回文本粘贴逻辑
      }
    }
    if (!navigator.clipboard?.readText) throw new Error("当前环境不支持读取剪贴板");
    const text = await navigator.clipboard.readText();
    if (text) {
      pane.terminal.paste(text);
    } else if (isTauriRuntime()) {
      // 文本为空但用户主动粘贴：大概率是截图类图片，交给 pi 自行判断剪贴板内容
      queuePanePtyWrite(pane, new TextEncoder().encode("\x1bv"));
    }
  } catch (error) {
    showToast(error instanceof Error ? error.message : "粘贴终端内容失败");
  } finally {
    pane.terminal.focus();
  }
}

/** 从 PTY 字节流中拦截 iTerm2 内联图片序列（ESC ] 1337 ; File=... : base64 BEL/ESC\），
 * 图片字节落盘，完整路径写回终端流供悬浮预览，其余字节原样透传给 xterm。跨 chunk 状态机。 */
class PtyImageExtractor {
  private tail: number[] = [];
  private state:
    | "collect"
    | "esc"
    | "head"
    | "header"
    | "payload"
    | "term"
    | "termEsc"
    | "passthrough"
    | "passthroughEsc" = "collect";
  private match = 0;
  private headerText = "";
  private payloadChunks: Uint8Array[] = [];
  private payloadLeft = 0;
  private seq = 0;
  private lastMarker: string | null = null;
  private readonly textDecoder = new TextDecoder();

  private static readonly FULL_HEAD = [
    0x1b, 0x5d, 0x31, 0x33, 0x33, 0x37, 0x3b, 0x46, 0x69, 0x6c, 0x65, 0x3d,
  ]; // ESC ] 1 3 3 7 ; F i l e =
  private static readonly MAX_HEADER = 4096;
  private static readonly MAX_PAYLOAD = 64 * 1024 * 1024;

  constructor(
    private readonly ownerId: number,
    private readonly onImage: (bytes: Uint8Array, path: string) => void,
    private readonly onText: (text: string) => void,
  ) {}

  write(data: Uint8Array): void {
    let plain: number[] = [];
    const flush = () => {
      if (plain.length > 0) {
        this.onText(this.textDecoder.decode(Uint8Array.from(plain), { stream: true }));
        plain = [];
      }
    };
    let i = 0;
    const n = data.length;
    while (i < n) {
      const b = data[i];
      switch (this.state) {
        case "collect": {
          if (b === 0x1b) {
            flush();
            this.tail = [b];
            this.match = 1;
            this.state = "head";
          } else plain.push(b);
          i += 1;
          break;
        }
        case "head": {
          if (this.match === 1) {
            // ESC 后第一个字节：只有 ']' 才是 OSC；其余（如 CSI 的 '['）原样放行
            this.tail.push(b);
            if (b === 0x5d) {
              this.match = 2;
            } else {
              this.tailTo(plain);
              this.state = "collect";
            }
            i += 1;
            break;
          }
          if (this.match < PtyImageExtractor.FULL_HEAD.length && b === PtyImageExtractor.FULL_HEAD[this.match]) {
            this.tail.push(b);
            this.match += 1;
            if (this.match === PtyImageExtractor.FULL_HEAD.length) {
              this.headerText = "";
              this.state = "header";
            }
          } else {
            // 确认是 OSC 但不是 1337;File=：整段透传（含负载直到 BEL 或 ESC\）
            this.tail.push(b);
            if (b === 0x07) {
              this.tailTo(plain);
              this.state = "collect";
            } else {
              this.state = b === 0x1b ? "passthroughEsc" : "passthrough";
            }
          }
          i += 1;
          break;
        }
        case "header": {
          this.tail.push(b);
          if (b === 0x3a) {
            const size = /size=(\d+)/.exec(this.headerText);
            const need = size ? Number.parseInt(size[1], 10) : -1;
            if (need > 0 && need <= PtyImageExtractor.MAX_PAYLOAD) {
              this.payloadLeft = need;
              this.payloadChunks = [];
              this.state = "payload";
            } else {
              this.tailTo(plain);
              this.state = "passthrough";
            }
          } else {
            this.headerText += String.fromCharCode(b);
            if (this.headerText.length > PtyImageExtractor.MAX_HEADER) {
              this.tailTo(plain);
              this.state = "passthrough";
            }
          }
          i += 1;
          break;
        }
        case "payload": {
          const take = Math.min(this.payloadLeft, n - i);
          this.payloadChunks.push(data.slice(i, i + take));
          this.payloadLeft -= take;
          i += take;
          if (this.payloadLeft === 0) this.state = "term";
          break;
        }
        case "term": {
          if (b === 0x07) {
            this.fire();
            this.emitMarker(plain);
            this.state = "collect";
          } else if (b === 0x1b) {
            this.state = "termEsc";
          } else {
            this.fire();
            this.emitMarker(plain);
            plain.push(b);
            this.state = "collect";
          }
          i += 1;
          break;
        }
        case "termEsc": {
          if (b === 0x5c) {
            this.fire();
            this.emitMarker(plain);
            this.state = "collect";
          } else {
            this.fire();
            this.emitMarker(plain);
            this.tail.push(b);
            this.tailTo(plain);
            this.state = "collect";
          }
          i += 1;
          break;
        }
        case "passthrough": {
          this.tail.push(b);
          if (b === 0x07) {
            this.tailTo(plain);
            this.state = "collect";
          } else if (b === 0x1b) {
            this.state = "passthroughEsc";
          }
          i += 1;
          break;
        }
        case "passthroughEsc": {
          this.tail.push(b);
          this.tailTo(plain);
          this.state = "collect";
          i += 1;
          break;
        }
      }
    }
    flush();
  }

  dispose(): void {}

  private tailTo(plain: number[]): void {
    plain.push(...this.tail);
    this.tail = [];
  }

  /** 图片剥离后，在原位置注入青绿色短标记（纯文本，随文字 reflow，永不被截断） */
  private emitMarker(plain: number[]): void {
    if (!this.lastMarker) return;
    plain.push(...new TextEncoder().encode(this.lastMarker));
    this.lastMarker = null;
  }

  private fire(): void {
    this.tail = [];
    this.lastMarker = null;
    try {
      const total = this.payloadChunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const base64Bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of this.payloadChunks) {
        base64Bytes.set(chunk, offset);
        offset += chunk.length;
      }
      this.payloadChunks = [];
      let binary = "";
      const block = 0x8000;
      for (let i = 0; i < total; i += block) {
        binary += String.fromCharCode(...base64Bytes.subarray(i, Math.min(i + block, total)));
      }
      const raw = atob(binary);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
      this.seq += 1;
      const path = `/tmp/qq-img-${this.ownerId}-${this.seq}.${sniffImageExtension(bytes)}`;
      this.lastMarker = `\x1b[36m${path}\x1b[0m`;
      this.onImage(bytes, path);
    } catch {
      // 解码失败则丢弃该张图片，不影响终端流
    }
  }
}

let hoverPreviewEl: HTMLElement | null = null;
let hoverPreviewPinned = false;
let hoverPreviewPath = "";

/** 终端里可悬浮预览的图片路径（POSIX 绝对路径 / Windows 盘符 / UNC） */
const IMAGE_PATH_REGEX =
  /(?:\\\\[^\s"'<>|]+|[A-Za-z]:\\[^\s"'<>|]+|\/[^\s"'<>|]+)\.(?:png|jpe?g|gif|webp|bmp)/gi;
/** 终端里可点击用系统默认程序打开的文件路径（任意类型）：绝对路径 + 扩展名结尾；
 * 排除图片（图片走悬浮预览/大图）；扩展名后须是空白/行尾，避免路径中
 * 间目录带点（/a/b.c/d）或 yml:3:5 位置后缀被截成半截路径 */
const FILE_PATH_REGEX =
  /(?:\\[^\s"'<>|]+|[A-Za-z]:\\[^\s"'<>|]+|\/[^\s"'<>|]+)\.(?!png|jpe?g|gif|webp|bmp)[A-Za-z0-9]{1,8}(?=[\s"'!,.;?*_`~<>()（）\[\]【】《》""''…,，。、；：？！]|$)/gi;
/** 路径 → data: URL 缓存：带 mtime/size 失效判定，同名文件重绘后悬浮自动刷新 */
interface CachedTerminalImage {
  url: string;
  mtimeMs: number;
  size: number;
}
const terminalImageCache = new Map<string, CachedTerminalImage>();

export function cacheTerminalImage(path: string, entry: CachedTerminalImage): void {
  terminalImageCache.delete(path);
  terminalImageCache.set(path, entry);
  while (terminalImageCache.size > 24) {
    const oldest = terminalImageCache.keys().next().value;
    if (oldest === undefined) break;
    terminalImageCache.delete(oldest);
  }
}

/** 读磁盘图片为 data: URL：先 stat 比对 mtime/size，未变才用缓存；
 *  变了（脚本同名覆盖重绘）则重读并刷新缓存；读后再次 stat 取最终戳，
 *  防止读到的内容比读前 stat 更新时把新图配旧戳 */
export async function resolveTerminalImage(path: string): Promise<string> {
  let stat: { mtimeMs: number; size: number } | null = null;
  try {
    stat = await backend.statTerminalImage(path);
  } catch {
    stat = null; // stat 不可用时退化为直读
  }
  const cached = terminalImageCache.get(path);
  if (cached && stat && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.url;
  }
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const url = await backend.readTerminalImage(path);
      let stamp = stat;
      try {
        stamp = await backend.statTerminalImage(path);
      } catch {
        // 保留读前 stat；拿不到就用零值（下次悬浮会再重读一次，无害）
      }
      cacheTerminalImage(path, {
        url,
        mtimeMs: stamp?.mtimeMs ?? 0,
        size: stamp?.size ?? 0,
      });
      return url;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => window.setTimeout(resolve, 300));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** 悬浮路径：读盘后弹瞬时预览；文件不可读时静默，避免误悬浮打扰 */
export async function previewTerminalImage(path: string, event: MouseEvent): Promise<void> {
  try {
    const url = await resolveTerminalImage(path);
    showHoverPreview(url, path, event);
  } catch {
    // 文件不存在（如 /tmp 已清理）：不弹预览
  }
}

/** 点击路径：读盘后弹固定面板（查看大图/固定/保存） */
export async function openPinnedImagePanel(path: string): Promise<void> {
  try {
    const url = await resolveTerminalImage(path);
    showPinnedImagePanel(url, path);
  } catch (error) {
    showToast(error instanceof Error ? error.message : "读取图片失败");
  }
}

/** 保存终端图片到宿主图片文件夹（Windows：图片\qq_codex） */
export async function saveTerminalImageAs(path: string): Promise<void> {
  if (!path) return;
  try {
    const target = await backend.exportTerminalImage(path);
    showToast(`已保存：${target}`);
  } catch (error) {
    showToast(error instanceof Error ? error.message : "保存图片失败");
  }
}

/** 点击文件路径：用系统默认程序打开（图片以外的任意文件） */
export async function openTerminalFile(path: string): Promise<void> {
  try {
    const target = await backend.openTerminalFile(path);
    showToast(`已打开：${target}`);
  } catch (error) {
    showToast(error instanceof Error ? error.message : "打开文件失败");
  }
}

/** 图片浮窗：悬浮=瞬时预览；点击路径=pinned 模式（查看大图/固定/保存/关闭） */
export function showHoverPreview(url: string, path: string, event: MouseEvent, pinned = false): void {
  let el = hoverPreviewEl;
  if (!el) {
    el = document.createElement("div");
    el.className = "image-hover-preview";
    const bar = document.createElement("div");
    bar.className = "image-hover-preview-bar";
    const pathLabel = document.createElement("span");
    pathLabel.className = "image-hover-preview-path";
    const view = document.createElement("button");
    view.type = "button";
    view.className = "image-hover-preview-btn";
    view.textContent = "🔍 查看大图";
    view.title = "高分辨率查看";
    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "image-hover-preview-btn image-hover-preview-pin";
    pin.textContent = "📌 固定";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "image-hover-preview-btn";
    save.textContent = "💾 保存";
    save.title = "保存到图片文件夹";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "image-hover-preview-btn";
    close.textContent = "✕";
    bar.append(pathLabel, view, pin, save, close);
    const img = document.createElement("img");
    el.append(bar, img);
    document.body.append(el);
    hoverPreviewEl = el;

    view.addEventListener("click", (clickEvent) => {
      clickEvent.stopPropagation();
      showImageZoomViewer(img.src);
    });
    pin.addEventListener("click", (clickEvent) => {
      clickEvent.stopPropagation();
      hoverPreviewPinned = !hoverPreviewPinned;
      pin.textContent = hoverPreviewPinned ? "📌 已固定" : "📌 固定";
      el?.classList.toggle("pinned", hoverPreviewPinned);
    });
    save.addEventListener("click", (clickEvent) => {
      clickEvent.stopPropagation();
      void saveTerminalImageAs(hoverPreviewPath);
    });
    close.addEventListener("click", (clickEvent) => {
      clickEvent.stopPropagation();
      hoverPreviewPinned = false;
      pin.textContent = "📌 固定";
      if (hoverPreviewEl) hoverPreviewEl.hidden = true;
    });
    img.addEventListener("click", (clickEvent) => {
      clickEvent.stopPropagation();
      showImageZoomViewer(img.src);
    });
  }
  const img = el.querySelector("img");
  if (img && img.getAttribute("src") !== url) img.src = url;
  const pathLabel = el.querySelector(".image-hover-preview-path");
  if (pathLabel) pathLabel.textContent = path;
  hoverPreviewPath = path;
  hoverPreviewPinned = pinned;
  const pinButton = el.querySelector(".image-hover-preview-pin");
  if (pinButton) pinButton.textContent = pinned ? "📌 已固定" : "📌 固定";
  el.classList.toggle("pinned", pinned);
  el.hidden = false;
  const boxWidth = 460;
  const boxHeight = 380;
  const pad = 14;
  let x = event.clientX + pad;
  let y = event.clientY + pad;
  if (x + boxWidth > window.innerWidth - 8) x = event.clientX - boxWidth - pad;
  if (y + boxHeight > window.innerHeight - 8) y = Math.max(8, event.clientY - boxHeight - pad);
  el.style.left = `${Math.max(8, x)}px`;
  el.style.top = `${Math.max(8, y)}px`;
}

export function hideHoverPreview(): void {
  if (hoverPreviewEl && !hoverPreviewPinned) hoverPreviewEl.hidden = true;
}

/** 点击路径：在屏幕中心弹出固定模式的图片面板（查看大图/固定/保存） */
export function showPinnedImagePanel(url: string, path: string): void {
  const el = hoverPreviewEl;
  if (!el || el.hidden) {
    showHoverPreview(url, path, {
      clientX: Math.max(60, window.innerWidth / 2 - 230),
      clientY: Math.max(60, window.innerHeight / 2 - 190),
    } as MouseEvent, true);
    return;
  }
  const img = el.querySelector("img");
  if (img) img.src = url;
  const pathLabel = el.querySelector(".image-hover-preview-path");
  if (pathLabel) pathLabel.textContent = path;
  hoverPreviewPinned = true;
  el.classList.add("pinned");
  el.hidden = false;
}

export function sniffImageExtension(bytes: Uint8Array): string {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) return "png";
  if (bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
  if (bytes.length > 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "gif";
  if (bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) return "webp";
  return "png";
}

/** 终端图片落盘：完整路径已写入终端流，这里把字节写入 WSL /tmp 供悬浮预览/保存 */
export function persistTerminalImage(pane: TerminalPaneRuntime, bytes: Uint8Array, path: string): void {
  if (pane.disposed || !isTauriRuntime()) return;
  void backend
    .saveTerminalImage(bytes, path.split("/").pop() ?? "qq-img.png")
    .catch(() => undefined);
}

/** 高分辨率查看器：屏幕中心 1/4 面积，1:1 像素展示，滚轮/滚动条平移，点击空白或 Esc 关闭 */
export function showImageZoomViewer(src: string): void {
  const overlay = document.createElement("div");
  overlay.className = "terminal-image-zoom";
  const caption = document.createElement("div");
  caption.className = "terminal-image-zoom-caption";
  caption.textContent = "高分辨率预览";
  const frame = document.createElement("div");
  frame.className = "terminal-image-zoom-frame";
  const inner = document.createElement("div");
  inner.className = "terminal-image-zoom-inner";
  const img = document.createElement("img");
  img.src = src;
  img.alt = "高分辨率图片";
  img.addEventListener("load", () => {
    caption.textContent = `${img.naturalWidth} × ${img.naturalHeight} · 1:1 像素 · 滚动查看细节 · 点击空白或 Esc 关闭`;
  });
  const close = () => {
    overlay.remove();
    window.removeEventListener("keydown", onKey, true);
  };
  const onKey = (keyEvent: KeyboardEvent) => {
    if (keyEvent.key === "Escape") {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      close();
    }
  };
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  window.addEventListener("keydown", onKey, true);
  inner.append(img);
  frame.append(inner);
  overlay.append(caption, frame);
  document.body.appendChild(overlay);
}

export function handleTerminalClipboardShortcut(
  pane: TerminalPaneRuntime,
  event: KeyboardEvent,
): boolean {
  const isClipboardShortcut =
    !event.ctrlKey && event.altKey && event.shiftKey && !event.metaKey;
  if (!isClipboardShortcut || (event.code !== "KeyC" && event.code !== "KeyV")) return true;

  event.preventDefault();
  event.stopPropagation();
  if (event.type === "keydown" && !event.repeat) {
    if (event.code === "KeyC") void copyTerminalSelection(pane);
    else void pasteTerminalClipboard(pane);
  }
  return false;
}

export function terminalWorkspace(
  contactId = state.snapshot?.activeContactId,
  create = false,
): TerminalWorkspace | null {
  if (!contactId || !isTerminalContact(contactId)) return null;
  let workspace = terminalWorkspaces.get(contactId);
  if (!workspace && create) {
    workspace = {
      contactId,
      projectFolder: terminalHooks.projectFolderForContact(contactId),
      layout: null,
      activePaneId: null,
      nextPaneId: 1,
      fitFrame: null,
      panes: new Map(),
    };
    terminalWorkspaces.set(contactId, workspace);
  }
  return workspace ?? null;
}

export function activeTerminalPane(
  workspace = terminalWorkspace(),
): TerminalPaneRuntime | null {
  return !workspace || workspace.activePaneId === null
    ? null
    : workspace.panes.get(workspace.activePaneId) ?? null;
}

export function terminalPaneIds(
  node: TerminalLayoutNode | null = terminalWorkspace()?.layout ?? null,
  result: number[] = [],
): number[] {
  if (!node) return result;
  if (node.kind === "pane") result.push(node.paneId);
  else {
    terminalPaneIds(node.first, result);
    terminalPaneIds(node.second, result);
  }
  return result;
}

export function replaceTerminalPaneNode(
  node: TerminalLayoutNode,
  paneId: number,
  replacement: TerminalLayoutNode,
): TerminalLayoutNode {
  if (node.kind === "pane") return node.paneId === paneId ? replacement : node;
  return {
    ...node,
    first: replaceTerminalPaneNode(node.first, paneId, replacement),
    second: replaceTerminalPaneNode(node.second, paneId, replacement),
  };
}

export function removeTerminalPaneNode(
  node: TerminalLayoutNode,
  paneId: number,
): TerminalLayoutNode | null {
  if (node.kind === "pane") return node.paneId === paneId ? null : node;
  const first = removeTerminalPaneNode(node.first, paneId);
  const second = removeTerminalPaneNode(node.second, paneId);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

export function updateTerminalPaneVisual(pane: TerminalPaneRuntime): void {
  pane.element.dataset.state = pane.state;
  pane.element.classList.toggle(
    "is-active",
    pane.id === pane.workspace.activePaneId,
  );
}

export function terminalPanePosition(
  paneId: number,
  workspace = terminalWorkspace(),
): number {
  const position = terminalPaneIds(workspace?.layout ?? null).indexOf(paneId);
  return position < 0 ? 1 : position + 1;
}

export function updateTerminalToolbarState(): void {
  const workspace = terminalWorkspace();
  const active = activeTerminalPane(workspace);
  const paneCount = workspace?.panes.size ?? 0;
  const splitDisabled = paneCount >= MAX_TERMINAL_PANES;
  query<HTMLButtonElement>("#terminal-split-left-right").disabled = splitDisabled;
  query<HTMLButtonElement>("#terminal-split-top-bottom").disabled = splitDisabled;
  query<HTMLButtonElement>("#terminal-clear").disabled = !active;
  query<HTMLButtonElement>("#terminal-restart").disabled =
    !active || active.state === "opening";
  if (isTerminalContact()) {
    const contactName = terminalHooks.getActiveContactName();
    query("#conversation-caption").textContent =
      paneCount > 1 ? `${contactName} · ${paneCount} 个窗格` : `${contactName}会话`;
  }
}

export function updateTerminalConnectionStatus(): void {
  if (!state.snapshot?.activeContactId || !isTerminalContact()) return;
  const workspace = terminalWorkspace();
  const pane = activeTerminalPane(workspace);
  if (!pane) {
    query("#connection-status").textContent = "正在启动 WSL 终端...";
    terminalHooks.updateTypingStatus();
    return;
  }
  const contactName = terminalHooks.getActiveContactName();
  const label = workspace && workspace.panes.size > 1
    ? `${contactName} · 窗格 ${terminalPanePosition(pane.id, workspace)}/${workspace.panes.size}`
    : contactName;
  const descriptions: Record<TerminalPaneState, string> = {
    opening: "正在连接 WSL PTY...",
    connected: "WSL PTY 已连接 · 支持 Codex 流式输出",
    exited: "会话已结束 · 点击重启",
    error: "启动失败 · 点击重启",
  };
  query("#connection-status").textContent = `${label} · ${descriptions[pane.state]}`;
  terminalHooks.updateTypingStatus();
}

export function setActiveTerminalPane(pane: TerminalPaneRuntime, focus = false): void {
  const { workspace } = pane;
  if (pane.disposed || workspace.panes.get(pane.id) !== pane) return;
  workspace.activePaneId = pane.id;
  workspace.panes.forEach(updateTerminalPaneVisual);
  if (state.snapshot?.activeContactId === workspace.contactId) {
    updateTerminalToolbarState();
    updateTerminalConnectionStatus();
    terminalHooks.updateSendState();
  }
  if (focus) pane.terminal.focus();
}

export function setSplitElementRatio(
  node: Extract<TerminalLayoutNode, { kind: "split" }>,
  first: HTMLElement,
  second: HTMLElement,
  divider: HTMLElement,
  ratio: number,
): void {
  node.ratio = Math.max(0.15, Math.min(0.85, ratio));
  first.style.flex = `${node.ratio} 1 0px`;
  second.style.flex = `${1 - node.ratio} 1 0px`;
  divider.setAttribute("aria-valuenow", String(Math.round(node.ratio * 100)));
}

export function updateSplitRatioFromPointer(
  event: PointerEvent,
  workspace: TerminalWorkspace,
  node: Extract<TerminalLayoutNode, { kind: "split" }>,
  container: HTMLElement,
  first: HTMLElement,
  second: HTMLElement,
  divider: HTMLElement,
): void {
  const rect = container.getBoundingClientRect();
  const dividerSize = node.direction === "left-right"
    ? divider.offsetWidth
    : divider.offsetHeight;
  const available = (node.direction === "left-right" ? rect.width : rect.height) - dividerSize;
  if (available <= 2) return;
  const pointer = node.direction === "left-right"
    ? event.clientX - rect.left
    : event.clientY - rect.top;
  const minimumRatio = Math.min(0.42, Math.max(0.15, 92 / available));
  const ratio = Math.max(
    minimumRatio,
    Math.min(1 - minimumRatio, (pointer - dividerSize / 2) / available),
  );
  setSplitElementRatio(node, first, second, divider, ratio);
  scheduleTerminalFit(workspace);
}

export function renderTerminalLayoutNode(
  node: TerminalLayoutNode,
  workspace: TerminalWorkspace,
): HTMLElement {
  if (node.kind === "pane") {
    const pane = workspace.panes.get(node.paneId);
    if (!pane) throw new Error(`Missing terminal pane: ${node.paneId}`);
    pane.element.style.flex = "";
    return pane.element;
  }

  const container = document.createElement("div");
  container.className = `terminal-split terminal-split--${node.direction}`;
  const first = renderTerminalLayoutNode(node.first, workspace);
  const second = renderTerminalLayoutNode(node.second, workspace);
  const divider = document.createElement("div");
  divider.className = `terminal-divider terminal-divider--${node.direction}`;
  divider.tabIndex = 0;
  divider.role = "separator";
  divider.setAttribute(
    "aria-orientation",
    node.direction === "left-right" ? "vertical" : "horizontal",
  );
  divider.setAttribute(
    "aria-label",
    node.direction === "left-right" ? "调整左右分屏比例" : "调整上下分屏比例",
  );
  divider.setAttribute("aria-valuemin", "15");
  divider.setAttribute("aria-valuemax", "85");
  setSplitElementRatio(node, first, second, divider, node.ratio);

  divider.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    divider.classList.add("is-dragging");
    divider.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      updateSplitRatioFromPointer(
        moveEvent,
        workspace,
        node,
        container,
        first,
        second,
        divider,
      );
    };
    const finish = () => {
      divider.classList.remove("is-dragging");
      divider.removeEventListener("pointermove", move);
      divider.removeEventListener("pointerup", finish);
      divider.removeEventListener("pointercancel", finish);
      scheduleTerminalFit(workspace);
    };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", finish);
    divider.addEventListener("pointercancel", finish);
  });
  divider.addEventListener("keydown", (event) => {
    const decrementKey = node.direction === "left-right" ? "ArrowLeft" : "ArrowUp";
    const incrementKey = node.direction === "left-right" ? "ArrowRight" : "ArrowDown";
    let ratio = node.ratio;
    if (event.key === decrementKey) ratio -= 0.05;
    else if (event.key === incrementKey) ratio += 0.05;
    else if (event.key === "Home") ratio = 0.2;
    else if (event.key === "End") ratio = 0.8;
    else return;
    event.preventDefault();
    setSplitElementRatio(node, first, second, divider, ratio);
    scheduleTerminalFit(workspace);
  });

  container.append(first, divider, second);
  return container;
}

export function renderTerminalLayout(workspace: TerminalWorkspace): void {
  if (state.snapshot?.activeContactId !== workspace.contactId) return;
  const ids = terminalPaneIds(workspace.layout);
  terminalHostEl().classList.toggle("is-split", ids.length > 1);
  if (workspace.layout) {
    terminalHostEl().replaceChildren(renderTerminalLayoutNode(workspace.layout, workspace));
  }
  else terminalHostEl().replaceChildren();
  ids.forEach((paneId, index) => {
    const pane = workspace.panes.get(paneId);
    if (!pane) return;
    pane.title.textContent = `WSL 终端 ${index + 1}`;
    pane.element.setAttribute("aria-label", `WSL 终端窗格 ${index + 1}`);
    pane.closeButton.disabled = ids.length <= 1;
    updateTerminalPaneVisual(pane);
  });
  updateTerminalToolbarState();
  scheduleTerminalFit(workspace);
}

export function queuePanePtyWrite(pane: TerminalPaneRuntime, data: Uint8Array): void {
  const sessionId = pane.sessionId;
  const generation = pane.generation;
  if (!sessionId || data.length === 0 || pane.disposed) return;
  pane.writeQueue = pane.writeQueue
    .catch(() => undefined)
    .then(() => {
      if (
        pane.disposed ||
        pane.generation !== generation ||
        pane.sessionId !== sessionId
      ) return;
      return backend.writePty(sessionId, data);
    })
    .catch((error) => {
      if (pane.generation === generation && pane.sessionId === sessionId) {
        showToast(error instanceof Error ? error.message : "终端输入失败");
      }
    });
}

export function resizeTerminalPaneToFit(pane: TerminalPaneRuntime): void {
  if (
    pane.disposed ||
    !pane.mounted ||
    terminalHostEl().hidden ||
    state.snapshot?.activeContactId !== pane.workspace.contactId
  ) return;
  if (pane.surface.clientWidth < 2 || pane.surface.clientHeight < 2) return;
  try {
    pane.fit.fit();
  } catch {
    // Layout transitions can expose a zero-sized pane for one animation frame.
  }
}

export function fitAllTerminalPanes(workspace = terminalWorkspace()): void {
  if (!workspace || state.snapshot?.activeContactId !== workspace.contactId) return;
  workspace.panes.forEach(resizeTerminalPaneToFit);
}

export function scheduleTerminalFit(workspace = terminalWorkspace()): void {
  if (!workspace || workspace.fitFrame !== null) return;
  workspace.fitFrame = requestAnimationFrame(() => {
    workspace.fitFrame = null;
    fitAllTerminalPanes(workspace);
  });
}

export function schedulePanePtyResize(
  pane: TerminalPaneRuntime,
  rows: number,
  cols: number,
): void {
  const sessionId = pane.sessionId;
  const generation = pane.generation;
  if (!sessionId || pane.disposed) return;
  if (pane.resizeTimer !== null) window.clearTimeout(pane.resizeTimer);
  pane.resizeTimer = window.setTimeout(() => {
    pane.resizeTimer = null;
    pane.resizeQueue = pane.resizeQueue
      .catch(() => undefined)
      .then(() => {
        if (
          pane.disposed ||
          pane.generation !== generation ||
          pane.sessionId !== sessionId
        ) return;
        return backend.resizePty(sessionId, rows, cols);
      })
      .catch((error) => {
        if (pane.generation === generation && pane.sessionId === sessionId) {
          showToast(error instanceof Error ? error.message : "终端大小同步失败");
        }
      });
  }, 45);
}

export function handleTerminalPaneExit(
  pane: TerminalPaneRuntime,
  generation: number,
  exit: PtyExit,
): void {
  if (
    pane.disposed ||
    pane.generation !== generation ||
    pane.sessionId !== exit.sessionId
  ) return;
  pane.sessionId = null;
  pane.state = exit.error ? "error" : "exited";
  const notice = exit.error
    ? `\r\n\r\n[终端错误] ${exit.error}\r\n`
    : `\r\n\r\n[终端已退出，exit ${exit.exitCode ?? "?"}${exit.signal ? ` · ${exit.signal}` : ""}]\r\n`;
  pane.terminal.write(notice);
  updateTerminalPaneVisual(pane);
  if (state.snapshot?.activeContactId === pane.workspace.contactId) {
    updateTerminalToolbarState();
    updateTerminalConnectionStatus();
  }
}

export async function openTerminalPane(pane: TerminalPaneRuntime): Promise<void> {
  if (!isTauriRuntime() || pane.disposed || pane.sessionId) return;
  if (pane.openPromise) return pane.openPromise;
  const generation = ++pane.generation;
  pane.state = "opening";
  updateTerminalPaneVisual(pane);
  if (state.snapshot?.activeContactId === pane.workspace.contactId) {
    updateTerminalToolbarState();
    updateTerminalConnectionStatus();
  }
  resizeTerminalPaneToFit(pane);

  let returnedSessionId: number | null = null;
  let earlyExit: PtyExit | null = null;
  let opening!: Promise<void>;
  opening = (async () => {
    const rows = Math.max(1, pane.terminal.rows || 24);
    const cols = Math.max(2, pane.terminal.cols || 80);
    const opened = await backend.openPty(
      rows,
      cols,
      (data) => {
        if (
          !pane.disposed &&
          pane.generation === generation &&
          pane.workspace.panes.get(pane.id) === pane
        ) {
          const bytes = ptyBytes(data);
          if (pane.extractor) pane.extractor.write(bytes);
          else pane.terminal.write(bytes);
          feedPaneAiActivity(pane, bytes);
        }
      },
      (exit) => {
        if (returnedSessionId === null) earlyExit = exit;
        else handleTerminalPaneExit(pane, generation, exit);
      },
      pane.workspace.projectFolder ?? undefined,
    );
    returnedSessionId = opened.sessionId;
    if (
      pane.disposed ||
      pane.generation !== generation ||
      pane.workspace.panes.get(pane.id) !== pane
    ) {
      await backend.closePty(opened.sessionId);
      return;
    }
    pane.sessionId = opened.sessionId;
    if (opened.project) terminalHooks.cacheProjectFolderResolution(pane.workspace, opened.project);
    pane.state = "connected";
    updateTerminalPaneVisual(pane);
    resizeTerminalPaneToFit(pane);
    if (earlyExit) handleTerminalPaneExit(pane, generation, earlyExit);
    if (state.snapshot?.activeContactId === pane.workspace.contactId) {
      updateTerminalToolbarState();
      updateTerminalConnectionStatus();
    }
  })()
    .catch((error) => {
      if (
        pane.disposed ||
        pane.generation !== generation ||
        pane.workspace.panes.get(pane.id) !== pane
      ) return;
      pane.state = "error";
      pane.terminal.write(
        `\r\n[无法启动终端] ${error instanceof Error ? error.message : String(error)}\r\n`,
      );
      updateTerminalPaneVisual(pane);
      showToast(error instanceof Error ? error.message : "无法启动终端");
      if (state.snapshot?.activeContactId === pane.workspace.contactId) {
        updateTerminalToolbarState();
        updateTerminalConnectionStatus();
      }
    })
    .finally(() => {
      if (pane.openPromise === opening) pane.openPromise = null;
    });
  pane.openPromise = opening;
  return opening;
}

export function handlePreviewTerminalInput(pane: TerminalPaneRuntime, data: string): void {
  for (const character of data) {
    if (character === "\r" || character === "\n") {
      const command = pane.lineBuffer.trim();
      pane.lineBuffer = "";
      pane.terminal.write("\r\n");
      if (!command) {
        pane.terminal.write("wsl$ ");
        continue;
      }
      void backend
        .executeTerminal(
          command,
          pane.workspace.contactId,
          pane.workspace.projectFolder?.path,
        )
        .then((execution) => {
          if (!pane.disposed) {
            pane.terminal.write(
              `${execution.outputMessage.text.replace(/\n/g, "\r\n")}\r\nwsl$ `,
            );
          }
        })
        .catch((error) => {
          if (!pane.disposed) {
            pane.terminal.write(
              `[error] ${error instanceof Error ? error.message : String(error)}\r\nwsl$ `,
            );
          }
        });
    } else if (character === "\u007f" || character === "\b") {
      if (pane.lineBuffer.length > 0) {
        pane.lineBuffer = pane.lineBuffer.slice(0, -1);
        pane.terminal.write("\b \b");
      }
    } else if (character >= " ") {
      pane.lineBuffer += character;
      pane.terminal.write(character);
    }
  }
}

type TerminalPaneAiState = "idle" | "running" | "approval" | "done";

// ── 项目文件夹 ↔ 终端 AI 状态联动（方案 A：输出启发式）──
// 扫描 PTY 输出中的 TUI 提示文字推断 AI 状态，映射到左侧项目文件夹行：
//   running  = AI 正在工作（codex / Claude Code / pi 运行时都显示 "esc to interrupt"）
//   approval = 等待审批（codex / Claude Code 的审批选项文案；
//               pi permissions.ts 命令审批：“是否批准执行这条命令？/允许执行/总是允许这条命令”；
//               pi sandbox 四种审批：提权审批、提权重跑审批、网络访问审批（批量）、
//               网络审批运行时单域名兑底——标题词 + 常驻状态行“🔒 权限/提权重跑/网络 审批请求:”，
//               状态行在弹窗期间常驻重绘、选择后清除，不会残留误报）
//   done     = 完成（codex 显式 "tokens used"；其余靠“运行标记消失 + 输出静默”启发式）
// 匹配失败时静默降级为不显示，不影响终端。要支持新的 CLI，往对应数组加正则即可。
const AI_ACTIVITY_PATTERNS: Record<Exclude<TerminalPaneAiState, "idle">, RegExp[]> = {
  running: [
    /\bto interrupt\b/gi,
    // pi 默认 working 行：盲文 spinner 帧 + “Working”（帧集来自 pi-tui DEFAULT_FRAMES；
    // 不裸用 “Working”/裸 spinner，避免 npm 等同款 spinner 和模型正文 “working” 误报）
    /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Working\b/gu,
  ],
  approval: [
    /\band (?:auto-)?approve\b/gi,
    /\bdon.t ask again\b/gi,
    /\bwhat to do differently\b/gi,
    /\bdo you want to (?:proceed|run|create|edit|make|update)\b/gi,
    /\besc to approve\b/gi,
    /批准执行/gu,
    /总是允许这条命令/gu,
    /审批原因[:：]/gu,
    // pi sandbox 提权审批 / 提权重跑审批（标题 + 常驻状态行）；
    // 网络审批请求状态行排除“0 个域名”清零形态，但覆盖单域名兑底（host 非数字）
    /提权(重跑)?审批/gu,
    /🔒\s*(权限|提权重跑)审批请求/gu,
    /🔒\s*网络审批请求[:：]\s*(?!0\s*个)\S/gu,
    // pi sandbox 网络访问审批（批量 / 运行时单域名兑底）
    /网络访问审批/gu,
    /未放行域名/gu,
    /写入 \.pi\/sandbox\.json/gu,
  ],
  done: [
    /\btokens used\b/gi,
    /\bturn ended\b/gi,
  ],
};
export const AI_ACTIVITY_TAIL_LIMIT = 3072;
const AI_ACTIVITY_QUIET_MS = 2600;
const AI_ACTIVITY_DONE_LINGER_MS = 6000;
export const AI_ACTIVITY_STATE_TEXT: Record<TerminalPaneAiState, string> = {
  idle: "",
  running: "AI 正在工作…",
  approval: "等待审批…",
  done: "已完成",
};

export function stripTerminalEscapes(text: string): string {
  return text
    .replace(/\u001bP[\s\S]{0,2048}?(?:\u001b\\|$)/g, "")
    .replace(/\u001b\][^\u0007\u001b]{0,2048}(?:\u0007|\u001b\\|$)?/g, "")
    .replace(/\u001b\[[0-9;?<=>!"' ]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-Z\\-_]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export function paneAiMarkerState(pane: TerminalPaneRuntime): TerminalPaneAiState | null {
  let best: TerminalPaneAiState | null = null;
  let bestIndex = -1;
  (Object.keys(AI_ACTIVITY_PATTERNS) as Array<keyof typeof AI_ACTIVITY_PATTERNS>).forEach((state) => {
    for (const pattern of AI_ACTIVITY_PATTERNS[state]) {
      for (const match of pane.aiTail.matchAll(pattern)) {
        const index = match.index ?? -1;
        if (index > bestIndex) {
          bestIndex = index;
          best = state;
        }
      }
    }
  });
  return best;
}

export function publishWorkspaceAiState(workspace: TerminalWorkspace): void {
  const folder = workspace.projectFolder;
  if (!folder) return;
  const states = [...workspace.panes.values()].map((pane) => pane.aiState);
  const aggregate: TerminalPaneAiState = states.includes("approval")
    ? "approval"
    : states.includes("running")
      ? "running"
      : states.includes("done")
        ? "done"
        : "idle";
  const previous = projectAiStates.get(folder.id) ?? "idle";
  projectAiStates.set(folder.id, aggregate);
  if (previous !== aggregate) applyProjectAiStateToDom(folder.id, aggregate);
}

export function applyProjectAiStateToDom(projectId: string, state: TerminalPaneAiState): void {
  const wrap = query<HTMLDivElement>("#contact-list").querySelector<HTMLElement>(
    `.project-folder-row-wrap[data-project-id="${CSS.escape(projectId)}"]`,
  );
  if (!wrap) return;
  if (state === "idle") delete wrap.dataset.aiState;
  else wrap.dataset.aiState = state;
  const status = wrap.querySelector<HTMLElement>(".project-folder-copy span");
  if (status) {
    status.textContent = state === "idle"
      ? terminalHooks.projectFolderPath(projectId) ?? status.textContent
      : AI_ACTIVITY_STATE_TEXT[state];
  }
}

export function setPaneAiState(pane: TerminalPaneRuntime, state: TerminalPaneAiState): void {
  if (pane.disposed || pane.aiState === state) return;
  pane.aiState = state;
  if (pane.aiDoneTimer !== null) {
    window.clearTimeout(pane.aiDoneTimer);
    pane.aiDoneTimer = null;
  }
  if (state === "done") {
    pane.aiDoneTimer = window.setTimeout(() => {
      pane.aiDoneTimer = null;
      if (!pane.disposed && pane.aiState === "done") setPaneAiState(pane, "idle");
    }, AI_ACTIVITY_DONE_LINGER_MS);
  }
  publishWorkspaceAiState(pane.workspace);
}

export function schedulePaneAiQuietCheck(pane: TerminalPaneRuntime): void {
  if (pane.aiQuietTimer !== null) window.clearTimeout(pane.aiQuietTimer);
  pane.aiQuietTimer = window.setTimeout(() => {
    pane.aiQuietTimer = null;
    if (pane.disposed || pane.aiState !== "running") return;
    const quiet = Date.now() - pane.aiLastOutputAt >= AI_ACTIVITY_QUIET_MS;
    const stillRunning = AI_ACTIVITY_PATTERNS.running.some(
      (pattern) => pane.aiTail.search(pattern) !== -1,
    );
    if (quiet && !stillRunning) setPaneAiState(pane, "done");
    else schedulePaneAiQuietCheck(pane);
  }, AI_ACTIVITY_QUIET_MS + 250);
}

export function feedPaneAiActivity(pane: TerminalPaneRuntime, data: Uint8Array): void {
  if (pane.disposed || !pane.workspace.projectFolder) return;
  const text = pane.aiDecoder.decode(data, { stream: true });
  if (!text) return;
  pane.aiTail = `${pane.aiTail}${stripTerminalEscapes(text)}`.slice(-AI_ACTIVITY_TAIL_LIMIT);
  pane.aiLastOutputAt = Date.now();
  const marker = paneAiMarkerState(pane);
  if (marker) setPaneAiState(pane, marker);
  schedulePaneAiQuietCheck(pane);
}

export function createTerminalPane(workspace: TerminalWorkspace): TerminalPaneRuntime {
  const id = workspace.nextPaneId++;
  const element = document.createElement("section");
  element.className = "terminal-pane";
  element.dataset.paneId = String(id);
  element.setAttribute("role", "group");

  const titlebar = document.createElement("header");
  titlebar.className = "terminal-pane-titlebar";
  const lamp = document.createElement("span");
  lamp.className = "terminal-pane-lamp";
  lamp.setAttribute("aria-hidden", "true");
  const title = document.createElement("strong");
  title.className = "terminal-pane-title";
  title.textContent = "WSL 终端";
  const detail = document.createElement("span");
  detail.className = "terminal-pane-detail";
  detail.textContent = "WSL PTY";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "terminal-pane-close";
  closeButton.title = "关闭此终端窗格";
  closeButton.setAttribute("aria-label", "关闭此终端窗格");
  closeButton.textContent = "×";
  titlebar.append(lamp, title, detail, closeButton);

  const surface = document.createElement("div");
  surface.className = "terminal-pane-surface";
  surface.lang = "zh-CN";
  element.append(titlebar, surface);

  const terminal = new XtermTerminal({
    allowTransparency: false,
    convertEol: false,
    cursorBlink: true,
    cursorStyle: "bar",
    disableStdin: false,
    fontFamily: '"Cascadia Mono", "JetBrains Mono", "Noto Sans Mono CJK SC", "WenQuanYi Micro Hei Mono", Consolas, monospace',
    fontSize: 14,
    lineHeight: 1.25,
    scrollback: 20_000,
    smoothScrollDuration: 0,
    tabStopWidth: 8,
    theme: {
      background: "#fffdf3",
      foreground: "#1d2428",
      cursor: "#0050ee",
      cursorAccent: "#fffdf3",
      selectionBackground: "#b9d5f4",
      black: "#172026",
      red: "#a52a2a",
      green: "#176b35",
      yellow: "#886900",
      blue: "#1e4f9b",
      magenta: "#7c3f7b",
      cyan: "#1d6971",
      white: "#d7d5c9",
      brightBlack: "#5e666b",
      brightRed: "#be3f3f",
      brightGreen: "#237f43",
      brightYellow: "#a17f00",
      brightBlue: "#316ac5",
      brightMagenta: "#9a5a9a",
      brightCyan: "#2d8b91",
      brightWhite: "#ffffff",
    },
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  // TUI（pi/codex/Claude Code 等）结束时退出备用屏（ESC[?1049/1047/47l），
  // xterm 切回主屏后视口会回到进入 TUI 前的旧位置（常在顶部）——“跳到开头”的成因。
  // 拦截退出序列，切回主屏后自动滚到底部，保持盯住最新输出。
  terminal.parser.registerCsiHandler({ final: "l" }, (params) => {
    const first = params[0];
    if (first === 1049 || first === 1047 || first === 47) {
      window.setTimeout(() => {
        if (!pane.disposed && terminal.buffer.active.type === "normal") {
          terminal.scrollToBottom();
        }
      }, 0);
    }
    return false; // 不拦截，交 xterm 默认处理（真正的主屏切换）
  });
  // 终端不渲染图片本体：OSC 1337 被拦截后只把落盘文件的完整路径写入
  // 终端流，悬浮路径预览、点击路径查看大图/固定/保存（见下方 link provider）。
  const pane: TerminalPaneRuntime = {
    workspace,
    id,
    element,
    surface,
    title,
    closeButton,
    terminal,
    fit,
    extractor: null,
    resizeObserver: null,
    sessionId: null,
    openPromise: null,
    lifecycleQueue: Promise.resolve(),
    writeQueue: Promise.resolve(),
    resizeQueue: Promise.resolve(),
    resizeTimer: null,
    lineBuffer: "",
    generation: 0,
    state: isTauriRuntime() ? "opening" : "connected",
    mounted: false,
    disposed: false,
    disposables: [],
    aiDecoder: new TextDecoder(),
    aiTail: "",
    aiState: "idle",
    aiLastOutputAt: 0,
    aiQuietTimer: null,
    aiDoneTimer: null,
  };
  terminal.attachCustomKeyEventHandler((event) => handleTerminalClipboardShortcut(pane, event));
  pane.extractor = new PtyImageExtractor(
    id,
    (bytes, path) => persistTerminalImage(pane, bytes, path),
    (text) => {
      // 输出前确认窗格仍存活（会话关闭后不再写入）
      if (pane.disposed || pane.workspace.panes.get(pane.id) !== pane) return;
      pane.terminal.write(text);
    },
  );
  // 图片路径链接：悬浮弹浮窗预览，点击进固定面板（查看大图/固定/保存）
  pane.disposables.push(
    terminal.registerLinkProvider({
      provideLinks: (line, callback) => {
        try {
          // xterm 传入的行号是 1-based（内部 OSC 链接器同样用 line - 1 取行）
          const lineBuffer = terminal.buffer.active.getLine(line - 1);
          if (!lineBuffer) return callback(undefined);
          const text = lineBuffer.translateToString(true);
          const links: XtermImageLink[] = [];
          const seen = new Set<string>();
          // URL（https://x/a.md）的路径段不识别：匹配起点左侧是 “:” 或以 “://” 结尾
          const isUrlBody = (index: number) =>
            index > 0 && (text[index - 1] === ":" || text.slice(0, index).endsWith("://"));
          for (const match of text.matchAll(IMAGE_PATH_REGEX)) {
            const path = match[0];
            const column = match.index ?? -1;
            if (column < 0 || seen.has(path) || isUrlBody(column)) continue;
            seen.add(path);
            links.push({
              range: {
                start: { x: column + 1, y: line },
                end: { x: column + 1 + path.length, y: line },
              },
              text: path,
              activate: () => void openPinnedImagePanel(path),
              hover: (hoverEvent) => void previewTerminalImage(path, hoverEvent),
              leave: () => hideHoverPreview(),
            });
          }
          // 任意文件路径：点击用系统默认程序打开（悬浮保持安静，xterm 自带下划线高亮）
          for (const match of text.matchAll(FILE_PATH_REGEX)) {
            const path = match[0];
            const column = match.index ?? -1;
            if (column < 0 || seen.has(path) || isUrlBody(column)) continue;
            seen.add(path);
            links.push({
              range: {
                start: { x: column + 1, y: line },
                end: { x: column + 1 + path.length, y: line },
              },
              text: path,
              activate: () => void openTerminalFile(path),
              hover: () => {},
              leave: () => {},
            });
          }
          callback(links.length > 0 ? (links as never) : undefined);
        } catch {
          callback(undefined);
        }
      },
    }),
  );
  element.addEventListener(
    "mousedown",
    (event) => {
      if ((event.target as Element).closest(".terminal-pane-close")) return;
      setActiveTerminalPane(pane);
    },
    { capture: true },
  );
  element.addEventListener("focusin", () => setActiveTerminalPane(pane));
  titlebar.addEventListener("mousedown", (event) => {
    if ((event.target as Element).closest(".terminal-pane-close")) return;
    window.setTimeout(() => pane.terminal.focus(), 0);
  });
  closeButton.addEventListener("click", (event) => {
    event.stopPropagation();
    void closeTerminalPane(pane);
  });
  return pane;
}

export function mountTerminalPane(pane: TerminalPaneRuntime): void {
  if (pane.mounted || pane.disposed) return;
  pane.terminal.open(pane.surface);
  pane.mounted = true;
  pane.disposables.push(
    pane.terminal.onData((data) => {
      if (isTauriRuntime()) queuePanePtyWrite(pane, new TextEncoder().encode(data));
      else handlePreviewTerminalInput(pane, data);
    }),
    pane.terminal.onBinary((data) => {
      if (isTauriRuntime()) {
        queuePanePtyWrite(
          pane,
          Uint8Array.from(data, (character) => character.charCodeAt(0) & 0xff),
        );
      }
    }),
    pane.terminal.onResize(({ rows, cols }) => {
      schedulePanePtyResize(pane, rows, cols);
    }),
  );
  pane.resizeObserver = new ResizeObserver(() => scheduleTerminalFit(pane.workspace));
  pane.resizeObserver.observe(pane.surface);
  if (!isTauriRuntime()) {
    const projectLine = pane.workspace.projectFolder
      ? `项目目录：${pane.workspace.projectFolder.path}\r\n`
      : "";
    pane.terminal.write(`Retro Messenger WSL 终端预览\r\n${projectLine}输入 help 查看模拟 Linux 命令。\r\nwsl$ `);
  }
  resizeTerminalPaneToFit(pane);
}

export function ensureTerminal(
  focus = true,
  contactId = state.snapshot?.activeContactId,
): TerminalPaneRuntime | null {
  const workspace = terminalWorkspace(contactId, true);
  if (!workspace || state.snapshot?.activeContactId !== workspace.contactId) return null;
  terminalHostEl().hidden = false;
  transcriptEl().hidden = true;
  if (!workspace.layout) {
    const pane = createTerminalPane(workspace);
    workspace.panes.set(pane.id, pane);
    workspace.layout = { kind: "pane", paneId: pane.id };
    workspace.activePaneId = pane.id;
    renderTerminalLayout(workspace);
    mountTerminalPane(pane);
  } else {
    renderTerminalLayout(workspace);
  }
  fitAllTerminalPanes(workspace);
  workspace.panes.forEach((pane) => {
    if (isTauriRuntime() && !pane.sessionId && !pane.openPromise) {
      void openTerminalPane(pane);
    }
  });
  const active = activeTerminalPane(workspace);
  if (focus) active?.terminal.focus();
  scheduleTerminalFit(workspace);
  return active;
}

export async function splitActiveTerminal(direction: TerminalSplitDirection): Promise<void> {
  const workspace = terminalWorkspace();
  const active = ensureTerminal(false);
  if (!workspace || !active || !workspace.layout) return;
  if (workspace.panes.size >= MAX_TERMINAL_PANES) {
    showToast(`最多可同时打开 ${MAX_TERMINAL_PANES} 个终端窗格`);
    return;
  }
  const pane = createTerminalPane(workspace);
  workspace.panes.set(pane.id, pane);
  workspace.layout = replaceTerminalPaneNode(workspace.layout, active.id, {
    kind: "split",
    direction,
    ratio: 0.5,
    first: { kind: "pane", paneId: active.id },
    second: { kind: "pane", paneId: pane.id },
  });
  workspace.activePaneId = pane.id;
  renderTerminalLayout(workspace);
  mountTerminalPane(pane);
  setActiveTerminalPane(pane, true);
  fitAllTerminalPanes(workspace);
  if (isTauriRuntime()) await openTerminalPane(pane);
  scheduleTerminalFit(workspace);
}

export async function disposeTerminalPane(
  pane: TerminalPaneRuntime,
  alreadyInvalidated = false,
): Promise<void> {
  if (pane.disposed && !alreadyInvalidated) return;
  if (!alreadyInvalidated) {
    pane.disposed = true;
    pane.generation += 1;
  }
  if (pane.resizeTimer !== null) {
    window.clearTimeout(pane.resizeTimer);
    pane.resizeTimer = null;
  }
  if (pane.aiQuietTimer !== null) {
    window.clearTimeout(pane.aiQuietTimer);
    pane.aiQuietTimer = null;
  }
  if (pane.aiDoneTimer !== null) {
    window.clearTimeout(pane.aiDoneTimer);
    pane.aiDoneTimer = null;
  }
  pane.extractor?.dispose();
  pane.extractor = null;
  pane.resizeObserver?.disconnect();
  pane.resizeObserver = null;
  pane.disposables.splice(0).forEach((disposable) => disposable.dispose());
  publishWorkspaceAiState(pane.workspace);
  const sessionId = pane.sessionId;
  pane.sessionId = null;
  pane.terminal.dispose();
  if (sessionId) await backend.closePty(sessionId);
}

export async function disposeTerminalWorkspace(contactId: string): Promise<void> {
  const workspace = terminalWorkspaces.get(contactId);
  if (!workspace) return;
  if (workspace.fitFrame !== null) cancelAnimationFrame(workspace.fitFrame);
  workspace.fitFrame = null;
  const panes = [...workspace.panes.values()];
  workspace.panes.clear();
  workspace.layout = null;
  workspace.activePaneId = null;
  terminalWorkspaces.delete(contactId);
  await Promise.all(panes.map((pane) => disposeTerminalPane(pane)));
}

export async function closeTerminalPane(pane: TerminalPaneRuntime): Promise<void> {
  const { workspace } = pane;
  if (workspace.panes.size <= 1 || !workspace.layout) return;
  if (workspace.panes.get(pane.id) !== pane) return;
  const previousIds = terminalPaneIds(workspace.layout);
  const previousIndex = previousIds.indexOf(pane.id);
  pane.disposed = true;
  pane.generation += 1;
  workspace.panes.delete(pane.id);
  workspace.layout = removeTerminalPaneNode(workspace.layout, pane.id);
  const remainingIds = terminalPaneIds(workspace.layout);
  if (workspace.activePaneId === pane.id) {
    workspace.activePaneId =
      remainingIds[Math.min(Math.max(previousIndex, 0), remainingIds.length - 1)] ?? null;
  }
  renderTerminalLayout(workspace);
  await disposeTerminalPane(pane, true);
  const active = activeTerminalPane(workspace);
  if (active) setActiveTerminalPane(active, true);
  scheduleTerminalFit(workspace);
}

export async function restartTerminalPaneNow(pane: TerminalPaneRuntime): Promise<void> {
  if (pane.disposed || pane.workspace.panes.get(pane.id) !== pane) return;
  pane.generation += 1;
  const pendingOpen = pane.openPromise;
  pane.writeQueue = Promise.resolve();
  pane.resizeQueue = Promise.resolve();
  if (pane.resizeTimer !== null) {
    window.clearTimeout(pane.resizeTimer);
    pane.resizeTimer = null;
  }
  if (pendingOpen) await pendingOpen;
  if (pane.disposed) return;
  const oldSession = pane.sessionId;
  pane.sessionId = null;
  if (oldSession) await backend.closePty(oldSession);
  if (pane.disposed) return;
  pane.terminal.reset();
  pane.terminal.clear();
  pane.terminal.write("Retro Messenger WSL terminal\r\n");
  pane.lineBuffer = "";
  if (isTauriRuntime()) await openTerminalPane(pane);
  else {
    pane.state = "connected";
    pane.terminal.write("wsl$ ");
  }
  updateTerminalPaneVisual(pane);
  if (state.snapshot?.activeContactId === pane.workspace.contactId) {
    updateTerminalToolbarState();
    updateTerminalConnectionStatus();
  }
  pane.terminal.focus();
}

export async function restartTerminal(): Promise<void> {
  const pane = activeTerminalPane();
  if (!pane) return;
  pane.lifecycleQueue = pane.lifecycleQueue
    .catch(() => undefined)
    .then(() => restartTerminalPaneNow(pane));
  return pane.lifecycleQueue;
}

