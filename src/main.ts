import {
  ArrowLeft,
  Bell,
  Bold,
  ChevronDown,
  Clock3,
  Columns2,
  createIcons,
  Eraser,
  FileUp,
  History,
  Image,
  Italic,
  MailPlus,
  Maximize2,
  MessageSquare,
  Minus,
  Minimize2,
  MoreHorizontal,
  Palette,
  Paperclip,
  Phone,
  RefreshCw,
  Rows2,
  Search,
  Send,
  Settings,
  Smile,
  Terminal as TerminalIcon,
  Underline,
  UserPlus,
  Users,
  Video,
  Volume2,
  VolumeX,
  X,
  Zap,
} from "lucide";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Terminal as XtermTerminal, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

import "./styles.css";
import "@xterm/xterm/css/xterm.css";
import { backend, type PtyExit } from "./backend";
import {
  TERMINAL_CONTACT_ID,
  type AppSnapshot,
  type Contact,
  type Message,
  type Presence,
} from "./types";

import selfAvatar from "./assets/avatars/self.png";
import acheAvatar from "./assets/avatars/ache.png";
import linxiaAvatar from "./assets/avatars/linxia.png";
import mayuAvatar from "./assets/avatars/mayu.png";
import serviceAvatar from "./assets/avatars/service.png";
import oldfriendAvatar from "./assets/avatars/oldfriend.png";
import terminalAvatar from "./assets/avatars/terminal.png";

const appRoot = document.querySelector<HTMLDivElement>("#app");
if (!appRoot) throw new Error("Missing #app root");

const avatars: Record<string, string> = {
  self: selfAvatar,
  ache: acheAvatar,
  rain: acheAvatar,
  linxia: linxiaAvatar,
  "paper-plane": linxiaAvatar,
  mayu: mayuAvatar,
  sunset: mayuAvatar,
  service: serviceAvatar,
  terminal: terminalAvatar,
  oldfriend: oldfriendAvatar,
  night: oldfriendAvatar,
};

const presenceText: Record<Presence, string> = {
  online: "在线",
  away: "离开",
  busy: "忙碌",
  offline: "隐身",
};

const iconSet = {
  ArrowLeft,
  Bell,
  Bold,
  ChevronDown,
  Clock3,
  Columns2,
  Eraser,
  FileUp,
  History,
  Image,
  Italic,
  MailPlus,
  Maximize2,
  MessageSquare,
  Minus,
  Minimize2,
  MoreHorizontal,
  Palette,
  Paperclip,
  Phone,
  RefreshCw,
  Rows2,
  Search,
  Send,
  Settings,
  Smile,
  Terminal: TerminalIcon,
  Underline,
  UserPlus,
  Users,
  Video,
  Volume2,
  VolumeX,
  X,
  Zap,
};

type RosterTab = "friends" | "groups" | "recent";
type ResizeDirection =
  | "North"
  | "NorthEast"
  | "East"
  | "SouthEast"
  | "South"
  | "SouthWest"
  | "West"
  | "NorthWest";

type TerminalSplitDirection = "left-right" | "top-bottom";
type TerminalPaneState = "opening" | "connected" | "exited" | "error";
type TerminalLayoutNode =
  | { kind: "pane"; paneId: number }
  | {
      kind: "split";
      direction: TerminalSplitDirection;
      ratio: number;
      first: TerminalLayoutNode;
      second: TerminalLayoutNode;
    };

interface TerminalPaneRuntime {
  id: number;
  element: HTMLElement;
  surface: HTMLElement;
  title: HTMLElement;
  closeButton: HTMLButtonElement;
  terminal: XtermTerminal;
  fit: FitAddon;
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
}

let snapshot: AppSnapshot;
let messages: Message[] = [];
let activeTab: RosterTab = "friends";
let filterText = "";
let typingContactId: string | null = null;
let soundEnabled = true;
let shouldStickToBottom = true;
let messageInputComposing = false;
let messageCompositionResetTimer: number | null = null;
let lastWindowMaximized: boolean | null = null;
let windowStateSyncScheduled = false;
let terminalLayout: TerminalLayoutNode | null = null;
let activeTerminalPaneId: number | null = null;
let nextTerminalPaneId = 1;
let terminalFitFrame: number | null = null;
const terminalPanes = new Map<number, TerminalPaneRuntime>();
const MAX_TERMINAL_PANES = 4;
const collapsedGroups = new Set<string>();
const pendingReplies = new Set<string>();
const messageDrafts = new Map<string, string>();

function icon(name: keyof typeof iconSet, size = 16): string {
  return `<i data-lucide="${name}" data-size="${size}" aria-hidden="true"></i>`;
}

appRoot.innerHTML = `
  <main class="app-shell" id="app-shell">
    <header class="xp-titlebar" id="window-drag-region">
      <div class="window-title">
        <img class="title-icon" src="${selfAvatar}" alt="" draggable="false" />
        <span>OICQ 2003 - 即时消息</span>
      </div>
      <div class="window-controls" aria-label="窗口控制">
        <button class="window-button" id="minimize-window" aria-label="最小化" title="最小化">${icon("Minus", 13)}</button>
        <button class="window-button" id="maximize-window" aria-label="最大化" title="最大化">${icon("Maximize2", 12)}</button>
        <button class="window-button close" id="close-window" aria-label="关闭" title="关闭">${icon("X", 13)}</button>
      </div>
    </header>

    <nav class="menu-bar" aria-label="应用菜单">
      <button class="menu-trigger" data-menu="file"><u>文</u>件(F)</button>
      <button class="menu-trigger" data-menu="view"><u>查</u>看(V)</button>
      <button class="menu-trigger" data-menu="tools"><u>工</u>具(T)</button>
      <button class="menu-trigger" data-menu="help"><u>帮</u>助(H)</button>
    </nav>

    <div class="workspace">
      <aside class="roster-pane" aria-label="好友列表">
        <section class="self-profile">
          <div class="avatar-frame avatar-large">
            <img src="${selfAvatar}" alt="小鲸的头像" draggable="false" />
            <span class="presence-dot online" aria-label="在线"></span>
          </div>
          <div class="self-copy">
            <button class="self-name" id="presence-trigger" aria-haspopup="menu">
              <span id="self-display-name">小鲸</span>
              ${icon("ChevronDown", 12)}
            </button>
            <div class="self-state" id="self-state">[在线] 今天也要保持联络</div>
          </div>
          <div class="oicq-mark" aria-label="OICQ 2003">
            <b>OICQ</b><span>2003</span>
          </div>
        </section>

        <div class="search-strip">
          ${icon("Search", 14)}
          <input id="contact-search" type="search" placeholder="查找联系人" autocomplete="off" aria-label="查找联系人" />
          <button class="tiny-tool" id="add-contact" aria-label="添加联系人" title="添加联系人">${icon("UserPlus", 14)}</button>
        </div>

        <div class="roster-tabs" role="tablist" aria-label="联系人视图">
          <button class="roster-tab active" role="tab" data-tab="friends" aria-selected="true">好友</button>
          <button class="roster-tab" role="tab" data-tab="groups" aria-selected="false">群组</button>
          <button class="roster-tab" role="tab" data-tab="recent" aria-selected="false">最近</button>
        </div>

        <div class="contact-list" id="contact-list" role="listbox" aria-label="联系人"></div>

        <div class="roster-tools">
          <button class="tool-button" id="new-message" title="新建消息" aria-label="新建消息">${icon("MailPlus", 15)}</button>
          <button class="tool-button" id="show-recent" title="最近联系人" aria-label="最近联系人">${icon("Clock3", 15)}</button>
          <span class="tool-separator"></span>
          <button class="tool-button" id="sound-toggle" title="关闭声音" aria-label="关闭声音">${icon("Volume2", 15)}</button>
          <button class="tool-button" id="settings-button" title="设置状态" aria-label="设置状态">${icon("Settings", 15)}</button>
        </div>
      </aside>

      <div class="workspace-splitter" aria-hidden="true"></div>

      <section class="chat-pane" aria-label="聊天窗口">
        <header class="chat-contact-header">
          <button class="mobile-back" id="mobile-back" aria-label="返回好友列表" title="返回好友列表">${icon("ArrowLeft", 16)}</button>
          <div class="chat-contact-copy">
            <div class="chat-name-line">
              <strong id="chat-contact-name">正在连接...</strong>
              <span class="presence-label" id="chat-presence">[离线]</span>
              <span class="terminal-badge" id="terminal-badge" hidden>${icon("Terminal", 12)}<span>WSL SHELL</span></span>
            </div>
            <div class="chat-account" id="chat-account">OICQ: --</div>
            <div class="chat-signature" id="chat-signature"></div>
          </div>
          <div class="avatar-frame chat-avatar">
            <img id="chat-avatar" src="${serviceAvatar}" alt="联系人头像" draggable="false" />
            <span class="presence-dot offline" id="chat-presence-dot"></span>
          </div>
        </header>

        <div class="chat-actionbar" aria-label="聊天操作">
          <button class="tool-button" id="invite-contact" title="邀请联系人" aria-label="邀请联系人">${icon("Users", 15)}</button>
          <button class="tool-button" disabled title="发送文件（暂不可用）" aria-label="发送文件，暂不可用">${icon("FileUp", 15)}</button>
          <span class="tool-separator"></span>
          <button class="tool-button" disabled title="语音通话（暂不可用）" aria-label="语音通话，暂不可用">${icon("Phone", 15)}</button>
          <button class="tool-button" disabled title="视频通话（暂不可用）" aria-label="视频通话，暂不可用">${icon("Video", 15)}</button>
          <span class="tool-separator"></span>
          <button class="tool-button" id="history-button" title="查看聊天记录" aria-label="查看聊天记录">${icon("History", 15)}</button>
          <button class="tool-button terminal-only-control" id="terminal-clear" title="清屏" aria-label="清屏">${icon("Eraser", 15)}</button>
          <button class="tool-button terminal-only-control" id="terminal-restart" title="重启终端" aria-label="重启终端">${icon("RefreshCw", 15)}</button>
          <button class="tool-button terminal-only-control" id="terminal-split-left-right" title="左右分屏（新建终端）" aria-label="左右分屏，新建终端">${icon("Columns2", 15)}</button>
          <button class="tool-button terminal-only-control" id="terminal-split-top-bottom" title="上下分屏（新建终端）" aria-label="上下分屏，新建终端">${icon("Rows2", 15)}</button>
          <span class="actionbar-caption" id="conversation-caption">即时消息</span>
        </div>

        <div class="transcript-frame">
          <div class="transcript" id="transcript" tabindex="0" aria-label="聊天记录"></div>
          <div class="terminal-host" id="terminal-host" lang="zh-CN" aria-label="WSL 终端" hidden></div>
        </div>

        <div class="composer-splitter" aria-hidden="true"></div>

        <div class="format-toolbar" aria-label="消息格式">
          <button class="tool-button format-control" disabled title="粗体（纯文本模式不可用）" aria-label="粗体，暂不可用">${icon("Bold", 15)}</button>
          <button class="tool-button format-control" disabled title="斜体（纯文本模式不可用）" aria-label="斜体，暂不可用">${icon("Italic", 15)}</button>
          <button class="tool-button format-control" disabled title="下划线（纯文本模式不可用）" aria-label="下划线，暂不可用">${icon("Underline", 15)}</button>
          <button class="tool-button format-control" disabled title="字体颜色（纯文本模式不可用）" aria-label="字体颜色，暂不可用">${icon("Palette", 15)}</button>
          <span class="tool-separator"></span>
          <button class="tool-button" id="emoji-button" title="插入表情" aria-label="插入表情">${icon("Smile", 16)}</button>
          <button class="tool-button" id="nudge-button" title="发送窗口抖动" aria-label="发送窗口抖动">${icon("Zap", 15)}</button>
          <button class="tool-button" disabled title="发送图片（暂不可用）" aria-label="发送图片，暂不可用">${icon("Image", 15)}</button>
          <button class="tool-button" disabled title="添加附件（暂不可用）" aria-label="添加附件，暂不可用">${icon("Paperclip", 15)}</button>
          <span class="format-hint">纯文本</span>
        </div>

        <div class="composer-area">
          <textarea id="message-input" maxlength="2000" lang="zh-CN" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="输入消息" placeholder=""></textarea>
        </div>

        <div class="send-row">
          <span class="send-tip" id="send-tip">Enter 发送，Shift+Enter 换行</span>
          <div class="send-control">
            <button class="send-button" id="send-button" disabled>${icon("Send", 14)}<span>发送(S)</span></button>
            <button class="send-options" id="send-options" aria-label="发送选项" title="发送选项">${icon("ChevronDown", 12)}</button>
          </div>
        </div>
      </section>
    </div>

    <footer class="status-bar">
      <div class="status-pane connection"><span class="connection-lamp"></span><span id="connection-status">正在连接消息服务器...</span></div>
      <div class="status-pane typing" id="typing-status">就绪</div>
      <div class="status-pane clock" id="status-clock">--:--</div>
    </footer>

    <span class="resize-handle resize-n" data-resize-direction="North" aria-hidden="true"></span>
    <span class="resize-handle resize-ne" data-resize-direction="NorthEast" aria-hidden="true"></span>
    <span class="resize-handle resize-e" data-resize-direction="East" aria-hidden="true"></span>
    <span class="resize-handle resize-se" data-resize-direction="SouthEast" aria-hidden="true"></span>
    <span class="resize-handle resize-s" data-resize-direction="South" aria-hidden="true"></span>
    <span class="resize-handle resize-sw" data-resize-direction="SouthWest" aria-hidden="true"></span>
    <span class="resize-handle resize-w" data-resize-direction="West" aria-hidden="true"></span>
    <span class="resize-handle resize-nw" data-resize-direction="NorthWest" aria-hidden="true"></span>

    <div class="popup-menu" id="popup-menu" role="menu" hidden></div>
    <div class="toast" id="toast" role="status" hidden></div>
    <div class="dialog-backdrop" id="about-dialog" hidden>
      <section class="xp-dialog" role="dialog" aria-modal="true" aria-labelledby="about-title">
        <div class="dialog-titlebar"><span id="about-title">关于 OICQ 2003</span><button id="dialog-close" aria-label="关闭">${icon("X", 12)}</button></div>
        <div class="dialog-body">
          <img src="${selfAvatar}" alt="OICQ 像素企鹅" />
          <div><strong>OICQ 2003</strong><p>局域网即时通讯演示版</p><p>WebView2 GUI + WSL2 Terminal</p></div>
        </div>
        <div class="dialog-actions"><button class="xp-button default" id="dialog-ok">确定</button></div>
      </section>
    </div>
  </main>
`;

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}

const shell = query<HTMLElement>("#app-shell");
const contactList = query<HTMLDivElement>("#contact-list");
const chatPane = query<HTMLElement>(".chat-pane");
const transcript = query<HTMLDivElement>("#transcript");
const terminalHost = query<HTMLDivElement>("#terminal-host");
const messageInput = query<HTMLTextAreaElement>("#message-input");
const sendButton = query<HTMLButtonElement>("#send-button");
const popupMenu = query<HTMLDivElement>("#popup-menu");
const toast = query<HTMLDivElement>("#toast");
const aboutDialog = query<HTMLDivElement>("#about-dialog");

function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

function isTerminalContact(contactId = snapshot?.activeContactId): boolean {
  return contactId === TERMINAL_CONTACT_ID;
}

function refreshIcons(): void {
  createIcons({ icons: iconSet });
}

function ptyBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  if (value && typeof value === "object" && "buffer" in value) {
    const buffer = (value as { buffer?: unknown }).buffer;
    if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
  }
  return new TextEncoder().encode(String(value ?? ""));
}

function activeTerminalPane(): TerminalPaneRuntime | null {
  return activeTerminalPaneId === null
    ? null
    : terminalPanes.get(activeTerminalPaneId) ?? null;
}

function terminalPaneIds(
  node: TerminalLayoutNode | null = terminalLayout,
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

function replaceTerminalPaneNode(
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

function removeTerminalPaneNode(
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

function updateTerminalPaneVisual(pane: TerminalPaneRuntime): void {
  pane.element.dataset.state = pane.state;
  pane.element.classList.toggle("is-active", pane.id === activeTerminalPaneId);
}

function terminalPanePosition(paneId: number): number {
  const position = terminalPaneIds().indexOf(paneId);
  return position < 0 ? 1 : position + 1;
}

function updateTerminalToolbarState(): void {
  const active = activeTerminalPane();
  const paneCount = terminalPanes.size;
  const splitDisabled = paneCount >= MAX_TERMINAL_PANES;
  query<HTMLButtonElement>("#terminal-split-left-right").disabled = splitDisabled;
  query<HTMLButtonElement>("#terminal-split-top-bottom").disabled = splitDisabled;
  query<HTMLButtonElement>("#terminal-clear").disabled = !active;
  query<HTMLButtonElement>("#terminal-restart").disabled =
    !active || active.state === "opening";
  if (snapshot?.activeContactId === TERMINAL_CONTACT_ID) {
    query("#conversation-caption").textContent =
      paneCount > 1 ? `WSL 终端会话 · ${paneCount} 个窗格` : "WSL 终端会话";
  }
}

function updateTerminalConnectionStatus(): void {
  if (!snapshot?.activeContactId || !isTerminalContact()) return;
  const pane = activeTerminalPane();
  if (!pane) {
    query("#connection-status").textContent = "正在启动 WSL 终端...";
    updateTypingStatus();
    return;
  }
  const label = `WSL 终端 ${terminalPanePosition(pane.id)}/${terminalPanes.size}`;
  const descriptions: Record<TerminalPaneState, string> = {
    opening: "正在连接 WSL PTY...",
    connected: "WSL PTY 已连接 · 支持 Codex 流式输出",
    exited: "会话已结束 · 点击重启",
    error: "启动失败 · 点击重启",
  };
  query("#connection-status").textContent = `${label} · ${descriptions[pane.state]}`;
  updateTypingStatus();
}

function setActiveTerminalPane(pane: TerminalPaneRuntime, focus = false): void {
  if (pane.disposed || terminalPanes.get(pane.id) !== pane) return;
  activeTerminalPaneId = pane.id;
  terminalPanes.forEach(updateTerminalPaneVisual);
  updateTerminalToolbarState();
  updateTerminalConnectionStatus();
  updateSendState();
  if (focus) pane.terminal.focus();
}

function setSplitElementRatio(
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

function updateSplitRatioFromPointer(
  event: PointerEvent,
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
  scheduleTerminalFit();
}

function renderTerminalLayoutNode(node: TerminalLayoutNode): HTMLElement {
  if (node.kind === "pane") {
    const pane = terminalPanes.get(node.paneId);
    if (!pane) throw new Error(`Missing terminal pane: ${node.paneId}`);
    pane.element.style.flex = "";
    return pane.element;
  }

  const container = document.createElement("div");
  container.className = `terminal-split terminal-split--${node.direction}`;
  const first = renderTerminalLayoutNode(node.first);
  const second = renderTerminalLayoutNode(node.second);
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
      updateSplitRatioFromPointer(moveEvent, node, container, first, second, divider);
    };
    const finish = () => {
      divider.classList.remove("is-dragging");
      divider.removeEventListener("pointermove", move);
      divider.removeEventListener("pointerup", finish);
      divider.removeEventListener("pointercancel", finish);
      scheduleTerminalFit();
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
    scheduleTerminalFit();
  });

  container.append(first, divider, second);
  return container;
}

function renderTerminalLayout(): void {
  const ids = terminalPaneIds();
  terminalHost.classList.toggle("is-split", ids.length > 1);
  if (terminalLayout) terminalHost.replaceChildren(renderTerminalLayoutNode(terminalLayout));
  else terminalHost.replaceChildren();
  ids.forEach((paneId, index) => {
    const pane = terminalPanes.get(paneId);
    if (!pane) return;
    pane.title.textContent = `WSL 终端 ${index + 1}`;
    pane.element.setAttribute("aria-label", `WSL 终端窗格 ${index + 1}`);
    pane.closeButton.disabled = ids.length <= 1;
    updateTerminalPaneVisual(pane);
  });
  updateTerminalToolbarState();
  scheduleTerminalFit();
}

function queuePanePtyWrite(pane: TerminalPaneRuntime, data: Uint8Array): void {
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

function resizeTerminalPaneToFit(pane: TerminalPaneRuntime): void {
  if (pane.disposed || !pane.mounted || terminalHost.hidden) return;
  if (pane.surface.clientWidth < 2 || pane.surface.clientHeight < 2) return;
  try {
    pane.fit.fit();
  } catch {
    // Layout transitions can expose a zero-sized pane for one animation frame.
  }
}

function fitAllTerminalPanes(): void {
  terminalPanes.forEach(resizeTerminalPaneToFit);
}

function scheduleTerminalFit(): void {
  if (terminalFitFrame !== null) return;
  terminalFitFrame = requestAnimationFrame(() => {
    terminalFitFrame = null;
    fitAllTerminalPanes();
  });
}

function schedulePanePtyResize(
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

function handleTerminalPaneExit(
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
  updateTerminalToolbarState();
  updateTerminalConnectionStatus();
}

async function openTerminalPane(pane: TerminalPaneRuntime): Promise<void> {
  if (!isTauriRuntime() || pane.disposed || pane.sessionId) return;
  if (pane.openPromise) return pane.openPromise;
  const generation = ++pane.generation;
  pane.state = "opening";
  updateTerminalPaneVisual(pane);
  updateTerminalToolbarState();
  updateTerminalConnectionStatus();
  resizeTerminalPaneToFit(pane);

  let returnedSessionId: number | null = null;
  let earlyExit: PtyExit | null = null;
  let opening!: Promise<void>;
  opening = (async () => {
    const rows = Math.max(1, pane.terminal.rows || 24);
    const cols = Math.max(2, pane.terminal.cols || 80);
    const sessionId = await backend.openPty(
      rows,
      cols,
      (data) => {
        if (
          !pane.disposed &&
          pane.generation === generation &&
          terminalPanes.get(pane.id) === pane
        ) pane.terminal.write(ptyBytes(data));
      },
      (exit) => {
        if (returnedSessionId === null) earlyExit = exit;
        else handleTerminalPaneExit(pane, generation, exit);
      },
    );
    returnedSessionId = sessionId;
    if (
      pane.disposed ||
      pane.generation !== generation ||
      terminalPanes.get(pane.id) !== pane
    ) {
      await backend.closePty(sessionId);
      return;
    }
    pane.sessionId = sessionId;
    pane.state = "connected";
    updateTerminalPaneVisual(pane);
    resizeTerminalPaneToFit(pane);
    if (earlyExit) handleTerminalPaneExit(pane, generation, earlyExit);
    updateTerminalToolbarState();
    updateTerminalConnectionStatus();
  })()
    .catch((error) => {
      if (
        pane.disposed ||
        pane.generation !== generation ||
        terminalPanes.get(pane.id) !== pane
      ) return;
      pane.state = "error";
      pane.terminal.write(
        `\r\n[无法启动终端] ${error instanceof Error ? error.message : String(error)}\r\n`,
      );
      updateTerminalPaneVisual(pane);
      showToast(error instanceof Error ? error.message : "无法启动终端");
      updateTerminalToolbarState();
      updateTerminalConnectionStatus();
    })
    .finally(() => {
      if (pane.openPromise === opening) pane.openPromise = null;
    });
  pane.openPromise = opening;
  return opening;
}

function handlePreviewTerminalInput(pane: TerminalPaneRuntime, data: string): void {
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
        .executeTerminal(command)
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

function createTerminalPane(): TerminalPaneRuntime {
  const id = nextTerminalPaneId++;
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
  const pane: TerminalPaneRuntime = {
    id,
    element,
    surface,
    title,
    closeButton,
    terminal,
    fit,
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
  };
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
    void closeTerminalPane(pane.id);
  });
  return pane;
}

function mountTerminalPane(pane: TerminalPaneRuntime): void {
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
  pane.resizeObserver = new ResizeObserver(scheduleTerminalFit);
  pane.resizeObserver.observe(pane.surface);
  if (!isTauriRuntime()) {
    pane.terminal.write("Retro Messenger WSL 终端预览\r\n输入 help 查看模拟 Linux 命令。\r\nwsl$ ");
  }
  resizeTerminalPaneToFit(pane);
}

function ensureTerminal(focus = true): TerminalPaneRuntime | null {
  terminalHost.hidden = false;
  transcript.hidden = true;
  if (!terminalLayout) {
    const pane = createTerminalPane();
    terminalPanes.set(pane.id, pane);
    terminalLayout = { kind: "pane", paneId: pane.id };
    activeTerminalPaneId = pane.id;
    renderTerminalLayout();
    mountTerminalPane(pane);
  }
  fitAllTerminalPanes();
  terminalPanes.forEach((pane) => {
    if (isTauriRuntime() && !pane.sessionId && !pane.openPromise) {
      void openTerminalPane(pane);
    }
  });
  const active = activeTerminalPane();
  if (focus) active?.terminal.focus();
  scheduleTerminalFit();
  return active;
}

async function splitActiveTerminal(direction: TerminalSplitDirection): Promise<void> {
  const active = ensureTerminal(false);
  if (!active || !terminalLayout) return;
  if (terminalPanes.size >= MAX_TERMINAL_PANES) {
    showToast(`最多可同时打开 ${MAX_TERMINAL_PANES} 个终端窗格`);
    return;
  }
  const pane = createTerminalPane();
  terminalPanes.set(pane.id, pane);
  terminalLayout = replaceTerminalPaneNode(terminalLayout, active.id, {
    kind: "split",
    direction,
    ratio: 0.5,
    first: { kind: "pane", paneId: active.id },
    second: { kind: "pane", paneId: pane.id },
  });
  activeTerminalPaneId = pane.id;
  renderTerminalLayout();
  mountTerminalPane(pane);
  setActiveTerminalPane(pane, true);
  fitAllTerminalPanes();
  if (isTauriRuntime()) await openTerminalPane(pane);
  scheduleTerminalFit();
}

async function disposeTerminalPane(
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
  pane.resizeObserver?.disconnect();
  pane.resizeObserver = null;
  pane.disposables.splice(0).forEach((disposable) => disposable.dispose());
  const sessionId = pane.sessionId;
  pane.sessionId = null;
  pane.terminal.dispose();
  if (sessionId) await backend.closePty(sessionId);
}

async function closeTerminalPane(paneId: number): Promise<void> {
  if (terminalPanes.size <= 1 || !terminalLayout) return;
  const pane = terminalPanes.get(paneId);
  if (!pane) return;
  const previousIds = terminalPaneIds();
  const previousIndex = previousIds.indexOf(paneId);
  pane.disposed = true;
  pane.generation += 1;
  terminalPanes.delete(paneId);
  terminalLayout = removeTerminalPaneNode(terminalLayout, paneId);
  const remainingIds = terminalPaneIds();
  if (activeTerminalPaneId === paneId) {
    activeTerminalPaneId =
      remainingIds[Math.min(Math.max(previousIndex, 0), remainingIds.length - 1)] ?? null;
  }
  renderTerminalLayout();
  await disposeTerminalPane(pane, true);
  const active = activeTerminalPane();
  if (active) setActiveTerminalPane(active, true);
  scheduleTerminalFit();
}

async function restartTerminalPaneNow(pane: TerminalPaneRuntime): Promise<void> {
  if (pane.disposed || terminalPanes.get(pane.id) !== pane) return;
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
  updateTerminalToolbarState();
  updateTerminalConnectionStatus();
  pane.terminal.focus();
}

async function restartTerminal(): Promise<void> {
  const pane = activeTerminalPane();
  if (!pane) return;
  pane.lifecycleQueue = pane.lifecycleQueue
    .catch(() => undefined)
    .then(() => restartTerminalPaneNow(pane));
  return pane.lifecycleQueue;
}

function getActiveContact(): Contact {
  const contact = snapshot.contacts.find((item) => item.id === snapshot.activeContactId);
  if (!contact) throw new Error("Active contact is missing");
  return contact;
}

function avatarFor(contact: Contact): string {
  return avatars[contact.avatarSeed] ?? serviceAvatar;
}

function formatTime(timestamp: number, seconds = false): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: seconds ? "2-digit" : undefined,
    hour12: false,
  }).format(timestamp);
}

function updateClock(): void {
  query("#status-clock").textContent = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(Date.now());
}

function showToast(text: string): void {
  toast.textContent = text;
  toast.hidden = false;
  window.setTimeout(() => {
    toast.hidden = true;
  }, 2200);
}

function updateProfile(): void {
  query("#self-display-name").textContent = snapshot.currentUser.displayName;
  query("#self-state").textContent = `[${presenceText[snapshot.currentUser.presence]}] ${snapshot.currentUser.statusMessage}`;
  const dot = query<HTMLElement>(".self-profile .presence-dot");
  dot.className = `presence-dot ${snapshot.currentUser.presence}`;
}

function filteredContacts(): Contact[] {
  if (activeTab === "groups") return [];

  const normalized = filterText.trim().toLocaleLowerCase();
  const filtered = snapshot.contacts.filter((contact) => {
    if (!normalized) return true;
    return `${contact.displayName} ${contact.account} ${contact.statusMessage}`
      .toLocaleLowerCase()
      .includes(normalized);
  });

  if (activeTab === "recent") {
    return [...filtered].sort((left, right) => right.lastMessageAt - left.lastMessageAt);
  }
  return filtered;
}

function contactRow(contact: Contact): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `contact-row ${contact.presence}`;
  if (contact.id === TERMINAL_CONTACT_ID) button.classList.add("terminal-contact");
  if (contact.id === snapshot.activeContactId) button.classList.add("selected");
  button.dataset.contactId = contact.id;
  button.setAttribute("role", "option");
  button.setAttribute("aria-selected", String(contact.id === snapshot.activeContactId));

  const avatar = document.createElement("span");
  avatar.className = "contact-avatar avatar-frame";
  const image = document.createElement("img");
  image.src = avatarFor(contact);
  image.alt = "";
  image.draggable = false;
  const dot = document.createElement("span");
  dot.className = `presence-dot ${contact.presence}`;
  avatar.append(image, dot);

  const copy = document.createElement("span");
  copy.className = "contact-copy";
  const nameLine = document.createElement("span");
  nameLine.className = "contact-name-line";
  const name = document.createElement("strong");
  name.textContent = contact.displayName;
  nameLine.append(name);
  if (contact.unreadCount > 0) {
    const unread = document.createElement("span");
    unread.className = "unread-mail";
    unread.title = `${contact.unreadCount} 条未读消息`;
    unread.textContent = "✉";
    nameLine.append(unread);
  }
  const status = document.createElement("span");
  status.className = "contact-status";
  status.textContent = contact.statusMessage || contact.lastMessage;
  copy.append(nameLine, status);

  const time = document.createElement("span");
  time.className = "contact-time";
  time.textContent = formatTime(contact.lastMessageAt);
  button.append(avatar, copy, time);
  button.addEventListener("click", () => void selectContact(contact.id));
  return button;
}

function renderContacts(): void {
  contactList.replaceChildren();
  const contacts = filteredContacts();

  if (contacts.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-roster";
    empty.textContent = activeTab === "groups" ? "暂无群组" : "没有找到联系人";
    contactList.append(empty);
    return;
  }

  if (activeTab === "recent") {
    contacts.forEach((contact) => contactList.append(contactRow(contact)));
    return;
  }

  const grouped = new Map<string, Contact[]>();
  contacts.forEach((contact) => {
    const groupName = activeTab === "groups" ? `群组 · ${contact.group}` : contact.group;
    const items = grouped.get(groupName) ?? [];
    items.push(contact);
    grouped.set(groupName, items);
  });

  grouped.forEach((items, groupName) => {
    const groupButton = document.createElement("button");
    groupButton.type = "button";
    groupButton.className = "group-header";
    groupButton.dataset.group = groupName;
    const collapsed = collapsedGroups.has(groupName);
    groupButton.setAttribute("aria-expanded", String(!collapsed));
    groupButton.innerHTML = `<span class="tree-arrow">${collapsed ? "▶" : "▼"}</span><span></span><em>${items.filter((item) => item.presence !== "offline").length}/${items.length}</em>`;
    const label = groupButton.querySelector("span:nth-child(2)");
    if (label) label.textContent = groupName;
    groupButton.addEventListener("click", () => {
      if (collapsed) collapsedGroups.delete(groupName);
      else collapsedGroups.add(groupName);
      renderContacts();
    });
    contactList.append(groupButton);
    if (!collapsed) items.forEach((contact) => contactList.append(contactRow(contact)));
  });
}

function renderChatHeader(): void {
  const contact = getActiveContact();
  const terminalMode = isTerminalContact(contact.id);
  chatPane.classList.toggle("terminal-mode", terminalMode);
  terminalHost.hidden = !terminalMode;
  transcript.hidden = terminalMode;
  query("#chat-contact-name").textContent = contact.displayName;
  query("#chat-presence").textContent = terminalMode
    ? "[WSL]"
    : `[${presenceText[contact.presence]}]`;
  query("#chat-account").textContent = contact.account;
  query("#chat-signature").textContent = terminalMode
    ? "WSL2 默认发行版 · 支持 ANSI、交互程序与 Codex 流式输出"
    : contact.statusMessage;
  query("#conversation-caption").textContent = terminalMode
    ? "WSL 终端会话"
    : `正在与 ${contact.displayName} 交谈`;
  query<HTMLElement>("#terminal-badge").hidden = !terminalMode;
  document.querySelectorAll<HTMLElement>(".terminal-only-control").forEach((control) => {
    control.hidden = !terminalMode;
  });
  query(".format-hint").textContent = terminalMode ? "UTF-8 WSL 输入" : "纯文本";
  query("#send-button span").textContent = terminalMode ? "输入(T)" : "发送(S)";
  messageInput.placeholder = terminalMode
    ? "输入 Linux 命令或中文内容，Enter 发送到 WSL"
    : "";
  messageInput.setAttribute("aria-label", terminalMode ? "终端中文输入对话框" : "输入消息");
  transcript.setAttribute("aria-label", terminalMode ? "终端输出" : "聊天记录");
  const avatar = query<HTMLImageElement>("#chat-avatar");
  avatar.src = avatarFor(contact);
  avatar.alt = `${contact.displayName}的头像`;
  query("#chat-presence-dot").className = `presence-dot ${contact.presence}`;
  updateSendState();
  if (terminalMode) {
    ensureTerminal();
  }
}

function appendMessageGroup(container: HTMLElement, message: Message): HTMLElement {
  const group = document.createElement("section");
  group.className = `message-group ${message.outgoing ? "outgoing" : "incoming"}`;
  group.dataset.senderId = message.senderId;
  group.dataset.sentAt = String(message.sentAt);
  const meta = document.createElement("div");
  meta.className = "message-meta";
  const sender = document.createElement("strong");
  sender.textContent = message.senderName;
  const time = document.createElement("time");
  time.dateTime = new Date(message.sentAt).toISOString();
  time.textContent = formatTime(message.sentAt, true);
  meta.append(sender, time);
  group.append(meta);
  appendMessageBody(group, message.text);
  container.append(group);
  return group;
}

function appendMessageBody(group: HTMLElement, text: string): void {
  const body = document.createElement("p");
  body.className = "message-body";
  body.textContent = text;
  group.append(body);
}

function renderMessages(forceBottom = false): void {
  if (isTerminalContact()) {
    ensureTerminal();
    return;
  }
  const wasAtBottom =
    transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 28;
  transcript.replaceChildren();

  const dateSeparator = document.createElement("div");
  dateSeparator.className = "date-separator";
  dateSeparator.innerHTML = isTerminalContact()
    ? "<span>WSL TERMINAL</span>"
    : "<span>今天</span>";
  transcript.append(dateSeparator);

  let currentGroup: HTMLElement | null = null;
  let previous: Message | null = null;
  messages.forEach((message) => {
    const sameGroup =
      previous !== null &&
      previous.senderId === message.senderId &&
      message.sentAt - previous.sentAt < 5 * 60_000;
    if (sameGroup && currentGroup) appendMessageBody(currentGroup, message.text);
    else currentGroup = appendMessageGroup(transcript, message);
    previous = message;
  });

  if (messages.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-conversation";
    empty.textContent = "还没有聊天记录。现在发一条消息吧。";
    transcript.append(empty);
  }

  requestAnimationFrame(() => {
    if (forceBottom || wasAtBottom || shouldStickToBottom) {
      transcript.scrollTop = transcript.scrollHeight;
      shouldStickToBottom = true;
    }
  });
}

function updateTypingStatus(): void {
  const status = query("#typing-status");
  if (isTerminalContact()) {
    const pane = activeTerminalPane();
    const label = pane
      ? `WSL 终端 ${terminalPanePosition(pane.id)}/${terminalPanes.size}`
      : "WSL 终端";
    status.textContent = pane?.state === "connected"
      ? `${label} · WSL PTY 已连接`
      : `${label} · 未连接`;
    status.classList.add("terminal-active");
    status.classList.remove("active");
  } else if (typingContactId === snapshot.activeContactId) {
    status.textContent = `${getActiveContact().displayName} 正在输入...`;
    status.classList.add("active");
    status.classList.remove("terminal-active");
  } else {
    status.textContent = "就绪";
    status.classList.remove("active");
    status.classList.remove("terminal-active");
  }
}

function updateSendState(): void {
  const hasText = messageInput.value.trim().length > 0;
  if (isTerminalContact()) {
    const pane = activeTerminalPane();
    const paneLabel = pane && terminalPanes.size > 1
      ? ` · 发送到 WSL 终端 ${terminalPanePosition(pane.id)}`
      : "";
    sendButton.disabled = !hasText;
    query("#send-tip").textContent = hasText
      ? `${messageInput.value.length}/2000 · 中文输入法可用${paneLabel} · Enter 输入`
      : `中文输入法可用${paneLabel} · Enter 输入，Shift+Enter 换行`;
    return;
  }
  sendButton.disabled = !hasText;
  query("#send-tip").textContent = hasText
    ? `${messageInput.value.length}/2000  ·  Enter 发送`
    : "Enter 发送，Shift+Enter 换行";
}

function replaceContact(updated: Contact): void {
  const index = snapshot.contacts.findIndex((contact) => contact.id === updated.id);
  if (index >= 0) snapshot.contacts[index] = updated;
  if (updated.id === snapshot.currentUser.id) snapshot.currentUser = updated;
}

async function selectContact(contactId: string): Promise<void> {
  if (contactId === snapshot.activeContactId && shell.classList.contains("show-chat")) {
    if (isTerminalContact(contactId)) {
      ensureTerminal();
    }
    return;
  }
  messageDrafts.set(snapshot.activeContactId, messageInput.value);
  snapshot.activeContactId = contactId;
  messageInput.value = messageDrafts.get(contactId) ?? "";
  messageInputComposing = false;
  shell.classList.add("show-chat");
  renderContacts();
  renderChatHeader();
  query("#connection-status").textContent = "正在读取聊天记录...";
  try {
    const [conversation, contact] = await Promise.all([
      backend.getConversation(contactId),
      backend.markRead(contactId),
    ]);
    messages = conversation;
    replaceContact(contact);
    renderContacts();
    renderMessages(true);
    if (isTerminalContact(contactId)) {
      updateTerminalConnectionStatus();
      activeTerminalPane()?.terminal.focus();
    } else {
      query("#connection-status").textContent = "已连接到消息服务器";
      messageInput.focus();
    }
  } catch (error) {
    showToast(error instanceof Error ? error.message : "读取会话失败");
  }
  updateTypingStatus();
}

async function scheduleReply(contactId: string): Promise<void> {
  if (pendingReplies.has(contactId)) return;
  pendingReplies.add(contactId);
  typingContactId = contactId;
  updateTypingStatus();
  const delay = 720 + (contactId.length % 5) * 110;
  await new Promise((resolve) => window.setTimeout(resolve, delay));

  try {
    const reply = await backend.generateReply(contactId);
    const contact = snapshot.contacts.find((item) => item.id === contactId);
    if (contact) {
      contact.lastMessage = reply.text;
      contact.lastMessageAt = reply.sentAt;
      if (contactId !== snapshot.activeContactId) contact.unreadCount += 1;
    }
    if (contactId === snapshot.activeContactId) {
      messages.push(reply);
      renderMessages();
    }
    renderContacts();
    if (soundEnabled) shell.classList.add("message-flash");
    window.setTimeout(() => shell.classList.remove("message-flash"), 480);
  } catch (error) {
    showToast(error instanceof Error ? error.message : "自动回复失败");
  } finally {
    pendingReplies.delete(contactId);
    if (typingContactId === contactId) typingContactId = null;
    updateTypingStatus();
  }
}

function terminalSubmissionBytes(value: string, pane: TerminalPaneRuntime): Uint8Array {
  // Match xterm's own paste normalization: a terminal Enter key is CR, not LF.
  const normalized = value.replace(/\r\n|\r|\n/g, "\r");
  const input = pane.terminal.modes.bracketedPasteMode
    ? `\u001b[200~${normalized}\u001b[201~`
    : normalized;
  return new TextEncoder().encode(`${input}\r`);
}

async function sendCurrentMessage(overrideText?: string): Promise<void> {
  const contactId = snapshot.activeContactId;
  const rawText = overrideText ?? messageInput.value;
  const text = isTerminalContact(contactId) ? rawText : rawText.trim();
  if (!text.trim()) return;
  sendButton.disabled = true;
  try {
    if (isTerminalContact(contactId)) {
      // Keep the standard textarea focused so the platform IME context stays alive.
      const pane = ensureTerminal(false);
      if (!pane) throw new Error("没有可用的终端窗格");
      if (isTauriRuntime()) {
        if (!pane.sessionId) await openTerminalPane(pane);
        if (!pane.sessionId) throw new Error("终端尚未连接，请点击重启终端");
        queuePanePtyWrite(pane, terminalSubmissionBytes(text, pane));
      } else {
        handlePreviewTerminalInput(pane, `${text}\r`);
      }
      messageInput.value = "";
      messageDrafts.delete(contactId);
      updateSendState();
      messageInput.focus();
      return;
    }

    const sent = await backend.sendMessage(contactId, text);
    messages.push(sent);
    const contact = getActiveContact();
    contact.lastMessage = sent.text;
    contact.lastMessageAt = sent.sentAt;
    messageInput.value = "";
    messageDrafts.delete(contactId);
    updateSendState();
    renderContacts();
    renderMessages(true);
    messageInput.focus();
    void scheduleReply(contactId);
  } catch (error) {
    showToast(error instanceof Error ? error.message : "消息发送失败");
    updateSendState();
  }
}

function setTab(tab: RosterTab): void {
  activeTab = tab;
  document.querySelectorAll<HTMLButtonElement>(".roster-tab").forEach((button) => {
    const active = button.dataset.tab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  renderContacts();
}

function insertAtCursor(text: string): void {
  const start = messageInput.selectionStart;
  const end = messageInput.selectionEnd;
  messageInput.setRangeText(text, start, end, "end");
  updateSendState();
  messageInput.focus();
}

async function setUserPresence(presence: Presence): Promise<void> {
  try {
    const user = await backend.setPresence(presence);
    snapshot.currentUser = user;
    updateProfile();
    popupMenu.hidden = true;
  } catch (error) {
    showToast(error instanceof Error ? error.message : "状态更新失败");
  }
}

type MenuItem = { label: string; action?: () => void; disabled?: boolean; separator?: boolean };

function showPopup(anchor: HTMLElement, items: MenuItem[]): void {
  popupMenu.replaceChildren();
  items.forEach((item) => {
    if (item.separator) {
      const separator = document.createElement("div");
      separator.className = "popup-separator";
      popupMenu.append(separator);
      return;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.role = "menuitem";
    button.textContent = item.label;
    button.disabled = item.disabled ?? false;
    button.addEventListener("click", () => {
      popupMenu.hidden = true;
      item.action?.();
    });
    popupMenu.append(button);
  });
  popupMenu.hidden = false;
  popupMenu.style.visibility = "hidden";

  const anchorRect = anchor.getBoundingClientRect();
  const menuRect = popupMenu.getBoundingClientRect();
  const left = Math.max(3, Math.min(anchorRect.left, window.innerWidth - menuRect.width - 3));
  const preferredTop = anchorRect.bottom;
  const top = preferredTop + menuRect.height <= window.innerHeight - 3
    ? preferredTop
    : Math.max(3, anchorRect.top - menuRect.height);

  popupMenu.style.left = `${left}px`;
  popupMenu.style.top = `${top}px`;
  popupMenu.style.visibility = "visible";
}

function toggleSound(): void {
  soundEnabled = !soundEnabled;
  const button = query<HTMLButtonElement>("#sound-toggle");
  button.innerHTML = icon(soundEnabled ? "Volume2" : "VolumeX", 15);
  button.title = soundEnabled ? "关闭声音" : "打开声音";
  button.setAttribute("aria-label", button.title);
  refreshIcons();
  showToast(soundEnabled ? "消息提示音已打开" : "消息提示音已关闭");
}

function showAbout(): void {
  aboutDialog.hidden = false;
  query<HTMLButtonElement>("#dialog-ok").focus();
}

function closeAbout(): void {
  aboutDialog.hidden = true;
}

async function sendNudge(): Promise<void> {
  shell.classList.remove("window-nudge");
  void shell.offsetWidth;
  shell.classList.add("window-nudge");
  window.setTimeout(() => shell.classList.remove("window-nudge"), 460);
  await sendCurrentMessage("[窗口抖动]");
}

async function syncWindowState(): Promise<void> {
  const maximized = isTauriRuntime()
    ? await getCurrentWindow().isMaximized()
    : shell.classList.contains("preview-maximized");
  if (maximized === lastWindowMaximized) return;
  lastWindowMaximized = maximized;
  const button = query<HTMLButtonElement>("#maximize-window");
  button.innerHTML = icon(maximized ? "Minimize2" : "Maximize2", 12);
  button.title = maximized ? "还原" : "最大化";
  button.setAttribute("aria-label", button.title);
  shell.classList.toggle("window-maximized", maximized);
  refreshIcons();
}

function scheduleWindowStateSync(): void {
  if (windowStateSyncScheduled) return;
  windowStateSyncScheduled = true;
  requestAnimationFrame(() => {
    windowStateSyncScheduled = false;
    void syncWindowState();
  });
}

function startWindowDrag(event: MouseEvent): void {
  if (!isTauriRuntime() || event.button !== 0 || event.detail !== 1) return;
  if ((event.target as Element).closest(".window-controls")) return;
  // Call the native command directly from mousedown. Any async work before
  // this call can make tao lose the native drag gesture.
  void getCurrentWindow().startDragging().catch((error) => {
    showToast(error instanceof Error ? error.message : "窗口拖动失败");
  });
}

async function startWindowResize(direction: ResizeDirection, event: PointerEvent): Promise<void> {
  if (event.button !== 0 || !isTauriRuntime()) return;
  event.preventDefault();
  try {
    await getCurrentWindow().startResizeDragging(direction);
  } catch (error) {
    showToast(error instanceof Error ? error.message : "窗口缩放失败");
  }
}

async function windowAction(action: "minimize" | "maximize" | "close"): Promise<void> {
  try {
    if (isTauriRuntime()) {
      const appWindow = getCurrentWindow();
      if (action === "minimize") await appWindow.minimize();
      if (action === "maximize") {
        await appWindow.toggleMaximize();
        lastWindowMaximized = null;
        await syncWindowState();
      }
      if (action === "close") await appWindow.close();
      return;
    }
    if (action === "maximize") {
      shell.classList.toggle("preview-maximized");
      lastWindowMaximized = null;
      await syncWindowState();
      showToast(shell.classList.contains("preview-maximized") ? "窗口已最大化" : "窗口已还原");
    } else {
      showToast("该窗口操作仅在 Tauri 桌面版中执行");
    }
  } catch (error) {
    showToast(error instanceof Error ? error.message : "窗口操作失败");
  }
}

function bindEvents(): void {
  const dragRegion = query<HTMLElement>("#window-drag-region");
  dragRegion.addEventListener("mousedown", startWindowDrag);
  dragRegion.addEventListener("dblclick", (event) => {
    if (!(event.target as Element).closest(".window-controls")) {
      void windowAction("maximize");
    }
  });
  document.querySelectorAll<HTMLElement>("[data-resize-direction]").forEach((handle) => {
    handle.addEventListener("pointerdown", (event) => {
      void startWindowResize(handle.dataset.resizeDirection as ResizeDirection, event);
    });
  });
  query("#minimize-window").addEventListener("click", () => void windowAction("minimize"));
  query("#maximize-window").addEventListener("click", () => void windowAction("maximize"));
  query("#close-window").addEventListener("click", () => void windowAction("close"));

  query<HTMLInputElement>("#contact-search").addEventListener("input", (event) => {
    filterText = (event.currentTarget as HTMLInputElement).value;
    renderContacts();
  });
  query("#add-contact").addEventListener("click", () => showToast("添加联系人功能将在下一版本开放"));
  query("#new-message").addEventListener("click", () => messageInput.focus());
  query("#show-recent").addEventListener("click", () => setTab("recent"));
  query("#sound-toggle").addEventListener("click", toggleSound);
  query("#settings-button").addEventListener("click", (event) => {
    showPopup(event.currentTarget as HTMLElement, [
      { label: "在线", action: () => void setUserPresence("online") },
      { label: "离开", action: () => void setUserPresence("away") },
      { label: "忙碌", action: () => void setUserPresence("busy") },
      { separator: true, label: "" },
      { label: "隐身", action: () => void setUserPresence("offline") },
    ]);
  });
  query("#presence-trigger").addEventListener("click", (event) => {
    query("#settings-button").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    popupMenu.style.left = `${rect.left}px`;
  });

  document.querySelectorAll<HTMLButtonElement>(".roster-tab").forEach((button) => {
    button.addEventListener("click", () => setTab(button.dataset.tab as RosterTab));
  });

  messageInput.addEventListener("compositionstart", () => {
    if (messageCompositionResetTimer !== null) {
      window.clearTimeout(messageCompositionResetTimer);
      messageCompositionResetTimer = null;
    }
    messageInputComposing = true;
  });
  messageInput.addEventListener("compositionend", () => {
    // Some WebViews dispatch the candidate-confirming Enter immediately after
    // compositionend. Keep the guard for one event loop so it is not sent.
    messageCompositionResetTimer = window.setTimeout(() => {
      messageCompositionResetTimer = null;
      messageInputComposing = false;
    }, 0);
  });
  messageInput.addEventListener("input", () => {
    if (snapshot?.activeContactId) {
      messageDrafts.set(snapshot.activeContactId, messageInput.value);
    }
    updateSendState();
  });
  messageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      if (event.isComposing || messageInputComposing || event.keyCode === 229) return;
      event.preventDefault();
      void sendCurrentMessage();
    }
  });
  sendButton.addEventListener("click", () => void sendCurrentMessage());
  query("#send-options").addEventListener("click", (event) => {
    const action = isTerminalContact() ? "输入终端" : "发送";
    showPopup(event.currentTarget as HTMLElement, [
      { label: `按 Enter ${action}`, action: () => messageInput.focus() },
      { label: `按 Ctrl+Enter ${action}`, disabled: true },
    ]);
  });
  query("#emoji-button").addEventListener("click", () => insertAtCursor(" :-) "));
  query("#nudge-button").addEventListener("click", () => void sendNudge());
  query("#history-button").addEventListener("click", () => {
    if (isTerminalContact()) {
      const pane = activeTerminalPane();
      pane?.terminal.scrollToBottom();
      pane?.terminal.focus();
    } else {
      transcript.scrollTo({ top: 0, behavior: "smooth" });
      showToast("已定位到今天的第一条记录");
    }
  });
  query("#terminal-clear").addEventListener("click", () => {
    const pane = activeTerminalPane();
    pane?.terminal.clear();
    pane?.terminal.focus();
  });
  query("#terminal-restart").addEventListener("click", () => void restartTerminal());
  query("#terminal-split-left-right").addEventListener("click", () => {
    void splitActiveTerminal("left-right");
  });
  query("#terminal-split-top-bottom").addEventListener("click", () => {
    void splitActiveTerminal("top-bottom");
  });
  query("#invite-contact").addEventListener("click", () => showToast("当前会话仅支持双人聊天"));
  query("#mobile-back").addEventListener("click", () => shell.classList.remove("show-chat"));

  transcript.addEventListener("scroll", () => {
    shouldStickToBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 28;
  });
  contactList.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [...contactList.querySelectorAll<HTMLButtonElement>(".contact-row")];
    const current = document.activeElement as HTMLButtonElement;
    const index = rows.indexOf(current);
    const change = event.key === "ArrowDown" ? 1 : -1;
    rows[(index + change + rows.length) % rows.length]?.focus();
    event.preventDefault();
  });

  document.querySelectorAll<HTMLButtonElement>(".menu-trigger").forEach((button) => {
    button.addEventListener("click", () => {
      const menu = button.dataset.menu;
      const menuItems: Record<string, MenuItem[]> = {
        file: [
          { label: "新建即时消息", action: () => messageInput.focus() },
          { label: "发送文件...", disabled: true },
          { separator: true, label: "" },
          { label: "退出", action: () => void windowAction("close") },
        ],
        view: [
          { label: "好友列表", action: () => setTab("friends") },
          { label: "最近联系人", action: () => setTab("recent") },
          { label: "聊天记录", action: () => transcript.scrollTo({ top: 0 }) },
        ],
        tools: [
          { label: soundEnabled ? "关闭消息声音" : "打开消息声音", action: toggleSound },
          { label: "切换为在线", action: () => void setUserPresence("online") },
          { label: "切换为离开", action: () => void setUserPresence("away") },
        ],
        help: [
          { label: "使用说明", action: showAbout },
          { separator: true, label: "" },
          { label: "关于 OICQ 2003", action: showAbout },
        ],
      };
      showPopup(button, menuItems[menu ?? ""] ?? []);
    });
  });

  query("#dialog-close").addEventListener("click", closeAbout);
  query("#dialog-ok").addEventListener("click", closeAbout);
  aboutDialog.addEventListener("click", (event) => {
    if (event.target === aboutDialog) closeAbout();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!popupMenu.hidden && !popupMenu.contains(event.target as Node)) {
      const trigger = (event.target as Element).closest(".menu-trigger, #settings-button, #presence-trigger, #send-options");
      if (!trigger) popupMenu.hidden = true;
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      popupMenu.hidden = true;
      closeAbout();
    }
  });
}

async function start(): Promise<void> {
  refreshIcons();
  bindEvents();
  void syncWindowState();
  if (isTauriRuntime()) {
    const appWindow = getCurrentWindow();
    void appWindow.onResized(() => {
      scheduleWindowStateSync();
      scheduleTerminalFit();
    });
    void appWindow.onMoved(() => {
      scheduleWindowStateSync();
      scheduleTerminalFit();
    });
  }
  updateClock();
  window.setInterval(updateClock, 1000);
  try {
    snapshot = await backend.bootstrap();
    messages = snapshot.messages.filter(
      (message) => message.contactId === snapshot.activeContactId,
    );
    updateProfile();
    renderContacts();
    renderChatHeader();
    renderMessages(true);
    query("#connection-status").textContent = "已连接到消息服务器";
    updateTypingStatus();
    updateSendState();
    refreshIcons();
    if (isTerminalContact()) activeTerminalPane()?.terminal.focus();
    else messageInput.focus();
  } catch (error) {
    query("#connection-status").textContent = "连接失败";
    showToast(error instanceof Error ? error.message : "应用初始化失败");
  }
}

void start();
