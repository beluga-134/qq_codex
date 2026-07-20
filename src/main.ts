import {
  ArrowLeft,
  Bell,
  Bold,
  ChevronDown,
  Clock3,
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
import { backend } from "./backend";
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

let snapshot: AppSnapshot;
let messages: Message[] = [];
let activeTab: RosterTab = "friends";
let filterText = "";
let typingContactId: string | null = null;
let soundEnabled = true;
let shouldStickToBottom = true;
let terminal: XtermTerminal | null = null;
let terminalFit: FitAddon | null = null;
let terminalResizeObserver: ResizeObserver | null = null;
let terminalSessionId: number | null = null;
let terminalOpenPromise: Promise<void> | null = null;
let terminalWriteQueue = Promise.resolve();
let terminalResizeQueue = Promise.resolve();
let terminalResizeTimer: number | null = null;
let terminalLineBuffer = "";
let terminalExitNotice = "";
let terminalGeneration = 0;
let lastWindowMaximized: boolean | null = null;
let windowStateSyncScheduled = false;
const terminalDisposables: IDisposable[] = [];
const collapsedGroups = new Set<string>();
const pendingReplies = new Set<string>();

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
              <span class="terminal-badge" id="terminal-badge" hidden>${icon("Terminal", 12)}<span>LOCAL SHELL</span></span>
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
          <span class="actionbar-caption" id="conversation-caption">即时消息</span>
        </div>

        <div class="transcript-frame">
          <div class="transcript" id="transcript" tabindex="0" aria-label="聊天记录"></div>
          <div class="terminal-host" id="terminal-host" aria-label="本机终端" hidden></div>
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
          <textarea id="message-input" maxlength="2000" aria-label="输入消息" placeholder=""></textarea>
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
          <div><strong>OICQ 2003</strong><p>局域网即时通讯演示版</p><p>Rust + Tauri 2 / WebKitGTK</p></div>
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

function terminalDimensions(): { rows: number; cols: number } {
  return {
    rows: Math.max(1, terminal?.rows ?? 24),
    cols: Math.max(2, terminal?.cols ?? 80),
  };
}

function queuePtyWrite(data: Uint8Array): void {
  const sessionId = terminalSessionId;
  if (!sessionId || data.length === 0) return;
  terminalWriteQueue = terminalWriteQueue
    .catch(() => undefined)
    .then(() => backend.writePty(sessionId, data))
    .catch((error) => {
      if (sessionId === terminalSessionId) {
        showToast(error instanceof Error ? error.message : "终端输入失败");
      }
    });
}

function resizePtyToFit(): void {
  if (!terminal || !terminalFit || terminalHost.hidden) return;
  if (terminalHost.clientWidth < 2 || terminalHost.clientHeight < 2) return;
  try {
    terminalFit.fit();
  } catch {
    // FitAddon can briefly observe a zero-sized element while the pane changes.
  }
}

function schedulePtyResize(rows: number, cols: number): void {
  if (!terminalSessionId) return;
  if (terminalResizeTimer !== null) window.clearTimeout(terminalResizeTimer);
  const sessionId = terminalSessionId;
  terminalResizeTimer = window.setTimeout(() => {
    terminalResizeTimer = null;
    terminalResizeQueue = terminalResizeQueue
      .catch(() => undefined)
      .then(() => {
        if (sessionId !== terminalSessionId) return;
        return backend.resizePty(sessionId, rows, cols);
      })
      .catch((error) => {
        if (sessionId === terminalSessionId) {
          showToast(error instanceof Error ? error.message : "终端大小同步失败");
        }
      });
  }, 45);
}

function handleTerminalExit(exit: {
  sessionId: number;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
}): void {
  if (exit.sessionId !== terminalSessionId) return;
  terminalSessionId = null;
  terminalExitNotice = exit.error
    ? `\r\n\r\n[终端错误] ${exit.error}\r\n`
    : `\r\n\r\n[终端已退出，exit ${exit.exitCode ?? "?"}${exit.signal ? ` · ${exit.signal}` : ""}]\r\n`;
  terminal?.write(terminalExitNotice);
  query("#connection-status").textContent = "终端会话已结束 · 点击重启";
  updateTypingStatus();
}

async function openTerminalSession(force = false): Promise<void> {
  if (!isTauriRuntime()) return;
  if (terminalSessionId && !force) return;
  if (terminalOpenPromise) return terminalOpenPromise;
  const generation = ++terminalGeneration;
  terminalOpenPromise = (async () => {
    resizePtyToFit();
    const { rows, cols } = terminalDimensions();
    const sessionId = await backend.openPty(
      rows,
      cols,
      (data) => {
        if (generation === terminalGeneration) terminal?.write(ptyBytes(data));
      },
      handleTerminalExit,
    );
    terminalSessionId = sessionId;
    terminalExitNotice = "";
    resizePtyToFit();
    query("#connection-status").textContent = "本机终端已连接 · 支持 Codex 流式输出";
    updateTypingStatus();
  })()
    .catch((error) => {
      terminal?.write(`\r\n[无法启动终端] ${error instanceof Error ? error.message : String(error)}\r\n`);
      query("#connection-status").textContent = "终端启动失败";
      showToast(error instanceof Error ? error.message : "无法启动终端");
    })
    .finally(() => {
      terminalOpenPromise = null;
    });
  return terminalOpenPromise;
}

function handlePreviewTerminalInput(data: string): void {
  for (const character of data) {
    if (character === "\r" || character === "\n") {
      const command = terminalLineBuffer.trim();
      terminalLineBuffer = "";
      terminal?.write("\r\n");
      if (!command) {
        terminal?.write("$ ");
        continue;
      }
      void backend
        .executeTerminal(command)
        .then((execution) => {
          terminal?.write(`${execution.outputMessage.text.replace(/\n/g, "\r\n")}\r\n$ `);
        })
        .catch((error) => terminal?.write(`[error] ${error instanceof Error ? error.message : String(error)}\r\n$ `));
    } else if (character === "\u007f" || character === "\b") {
      if (terminalLineBuffer.length > 0) {
        terminalLineBuffer = terminalLineBuffer.slice(0, -1);
        terminal?.write("\b \b");
      }
    } else if (character >= " ") {
      terminalLineBuffer += character;
      terminal?.write(character);
    }
  }
}

function ensureTerminal(): void {
  terminalHost.hidden = false;
  transcript.hidden = true;
  if (!terminal) {
    terminal = new XtermTerminal({
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
    terminalFit = new FitAddon();
    terminal.loadAddon(terminalFit);
    terminal.open(terminalHost);
    terminalDisposables.push(
      terminal.onData((data) => {
        if (isTauriRuntime()) queuePtyWrite(new TextEncoder().encode(data));
        else handlePreviewTerminalInput(data);
      }),
      terminal.onBinary((data) => {
        if (isTauriRuntime()) {
          queuePtyWrite(Uint8Array.from(data, (character) => character.charCodeAt(0) & 0xff));
        }
      }),
      terminal.onResize(({ rows, cols }) => {
        schedulePtyResize(rows, cols);
      }),
    );
    terminalResizeObserver = new ResizeObserver(() => resizePtyToFit());
    terminalResizeObserver.observe(terminalHost);
    if (!isTauriRuntime()) {
      terminal.write("Retro Messenger terminal preview\r\nType help to try the mock shell.\r\n$ ");
    }
  }
  resizePtyToFit();
  if (isTauriRuntime()) void openTerminalSession();
  terminal.focus();
}

async function restartTerminal(): Promise<void> {
  if (!terminal) return;
  terminalGeneration += 1;
  terminalWriteQueue = Promise.resolve();
  terminalResizeQueue = Promise.resolve();
  if (terminalResizeTimer !== null) {
    window.clearTimeout(terminalResizeTimer);
    terminalResizeTimer = null;
  }
  if (terminalSessionId) {
    const oldSession = terminalSessionId;
    terminalSessionId = null;
    await backend.closePty(oldSession);
  }
  terminal.reset();
  terminal.clear();
  terminal.write("Retro Messenger terminal\r\n");
  if (isTauriRuntime()) {
    await openTerminalSession(true);
  } else {
    terminalLineBuffer = "";
    terminal.write("$ ");
  }
  terminal.focus();
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
    ? "[本机]"
    : `[${presenceText[contact.presence]}]`;
  query("#chat-account").textContent = contact.account;
  query("#chat-signature").textContent = terminalMode
    ? "持久 PTY · 支持 ANSI、交互程序与 Codex 流式输出"
    : contact.statusMessage;
  query("#conversation-caption").textContent = terminalMode
    ? "本机终端会话"
    : `正在与 ${contact.displayName} 交谈`;
  query<HTMLElement>("#terminal-badge").hidden = !terminalMode;
  document.querySelectorAll<HTMLElement>(".terminal-only-control").forEach((control) => {
    control.hidden = !terminalMode;
  });
  query(".format-hint").textContent = terminalMode ? "命令模式" : "纯文本";
  query("#send-button span").textContent = terminalMode ? "执行" : "发送(S)";
  messageInput.placeholder = terminalMode ? "输入命令，例如 help、pwd 或 ls" : "";
  messageInput.setAttribute("aria-label", terminalMode ? "输入终端命令" : "输入消息");
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
    ? "<span>LOCAL TERMINAL</span>"
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
    status.textContent = terminalSessionId ? "终端 · PTY 已连接" : "终端 · 未连接";
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
  if (isTerminalContact()) {
    sendButton.disabled = true;
    query("#send-tip").textContent = "终端已连接 · 直接在上方输入";
    return;
  }
  const hasText = messageInput.value.trim().length > 0;
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
      if (!terminalSessionId) void openTerminalSession();
    }
    return;
  }
  snapshot.activeContactId = contactId;
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
    query("#connection-status").textContent = isTerminalContact(contactId)
      ? terminalSessionId
        ? "本机终端已连接 · 支持 Codex 流式输出"
        : "正在启动本机终端..."
      : "已连接到消息服务器";
    if (isTerminalContact(contactId)) terminal?.focus();
    else messageInput.focus();
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

async function sendCurrentMessage(overrideText?: string): Promise<void> {
  const text = (overrideText ?? messageInput.value).trim();
  if (!text) return;
  const contactId = snapshot.activeContactId;
  sendButton.disabled = true;
  try {
    if (isTerminalContact(contactId)) {
      ensureTerminal();
      if (isTauriRuntime()) queuePtyWrite(new TextEncoder().encode(`${text}\r`));
      else handlePreviewTerminalInput(`${text}\r`);
      messageInput.value = "";
      updateSendState();
      terminal?.focus();
      return;
    }

    const sent = await backend.sendMessage(contactId, text);
    messages.push(sent);
    const contact = getActiveContact();
    contact.lastMessage = sent.text;
    contact.lastMessageAt = sent.sentAt;
    messageInput.value = "";
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

  terminalHost.addEventListener(
    "mousedown",
    () => {
      window.setTimeout(() => terminal?.focus(), 0);
    },
    { capture: true },
  );

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

  messageInput.addEventListener("input", updateSendState);
  messageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendCurrentMessage();
    }
  });
  sendButton.addEventListener("click", () => void sendCurrentMessage());
  query("#send-options").addEventListener("click", (event) => {
    const action = isTerminalContact() ? "执行" : "发送";
    showPopup(event.currentTarget as HTMLElement, [
      { label: `按 Enter ${action}`, action: () => messageInput.focus() },
      { label: `按 Ctrl+Enter ${action}`, disabled: true },
    ]);
  });
  query("#emoji-button").addEventListener("click", () => insertAtCursor(" :-) "));
  query("#nudge-button").addEventListener("click", () => void sendNudge());
  query("#history-button").addEventListener("click", () => {
    if (isTerminalContact()) {
      terminal?.scrollToBottom();
      terminal?.focus();
    } else {
      transcript.scrollTo({ top: 0, behavior: "smooth" });
      showToast("已定位到今天的第一条记录");
    }
  });
  query("#terminal-clear").addEventListener("click", () => {
    terminal?.clear();
    terminal?.focus();
  });
  query("#terminal-restart").addEventListener("click", () => void restartTerminal());
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
    void appWindow.onResized(scheduleWindowStateSync);
    void appWindow.onMoved(scheduleWindowStateSync);
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
    if (isTerminalContact()) terminal?.focus();
    else messageInput.focus();
  } catch (error) {
    query("#connection-status").textContent = "连接失败";
    showToast(error instanceof Error ? error.message : "应用初始化失败");
  }
}

void start();
