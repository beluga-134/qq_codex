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
  Folder,
  FolderOpen,
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
  Pencil,
  Phone,
  Plus,
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
  ZoomIn,
  ZoomOut,
} from "lucide";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Terminal as XtermTerminal, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

import "./styles.css";
import "@xterm/xterm/css/xterm.css";
import { backend, type PtyExit } from "./backend";
import {
  PROJECT_CONTACT_PREFIX,
  TERMINAL_CONTACT_ID,
  type AppSnapshot,
  type Contact,
  type Message,
  type Presence,
  type ProjectDirectory,
  type ProjectFolder,
  type ProjectFolderLocation,
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
  Folder,
  FolderOpen,
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
  Pencil,
  Phone,
  Plus,
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
  ZoomIn,
  ZoomOut,
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
  workspace: TerminalWorkspace;
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

interface TerminalWorkspace {
  contactId: string;
  projectFolder: ProjectFolder | null;
  layout: TerminalLayoutNode | null;
  activePaneId: number | null;
  nextPaneId: number;
  fitFrame: number | null;
  panes: Map<number, TerminalPaneRuntime>;
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
let renamingTerminalId: string | null = null;
let renamingProjectId: string | null = null;
let editingProjectDirectoryId: string | null = null;
let pendingProjectDirectoryId: string | null = null;
let pendingProjectRemovalId: string | null = null;
let toastTimer: number | null = null;
let contactSelectionSequence = 0;
const ZOOM_STORAGE_KEY = "ociq.ui.zoom";
const AVATAR_STORAGE_KEY = "ociq.profile.avatar";
const PROJECT_FOLDERS_STORAGE_KEY = "ociq.project-folders.v1";
const PROJECT_DIRECTORIES_STORAGE_KEY = "ociq.project-directories.v1";
const DEFAULT_PROJECT_DIRECTORY_ID = "default-project-directory";
const ZOOM_LEVELS = [0.75, 0.9, 1, 1.1, 1.25, 1.5];
let currentZoom = readStoredZoom();
let customAvatar = readStoredAvatar();
let pendingAvatar: string | null = customAvatar;
let projectDirectories = readStoredProjectDirectories();
let projectFolders = readStoredProjectFolders();
const terminalWorkspaces = new Map<string, TerminalWorkspace>();
const MAX_TERMINAL_PANES = 4;
const collapsedGroups = new Set<string>();
const pendingReplies = new Set<string>();
const messageDrafts = new Map<string, string>();

function icon(name: keyof typeof iconSet, size = 16): string {
  return `<i data-lucide="${name}" data-size="${size}" aria-hidden="true"></i>`;
}

function readStoredZoom(): number {
  try {
    const value = Number(localStorage.getItem(ZOOM_STORAGE_KEY));
    return ZOOM_LEVELS.includes(value) ? value : 1;
  } catch {
    return 1;
  }
}

function readStoredAvatar(): string | null {
  try {
    const value = localStorage.getItem(AVATAR_STORAGE_KEY);
    return value?.startsWith("data:image/webp;base64,") ? value : null;
  } catch {
    return null;
  }
}

function isStoredProjectPath(path: string): boolean {
  if (!path || [...path].length > 1024 || /[\u0000-\u001f\u007f]/.test(path)) return false;
  return /^[A-Za-z]:\\/.test(path)
    || /^\\\\[^\\]+\\[^\\]+/.test(path)
    || path.startsWith("/");
}

function isStoredWslPath(value: unknown): value is string {
  if (
    typeof value !== "string"
    || !value.startsWith("/")
    || [...value].length > 1024
    || /[\\\u0000-\u001f\u007f]/.test(value)
  ) return false;
  if (value === "/") return true;
  if (value.endsWith("/") || value.includes("//")) return false;
  return value.slice(1).split("/").every((component) => (
    component !== "." && component !== ".." && component !== "~"
  ));
}

function isStoredWslDistribution(value: unknown): value is string | null {
  if (value === null) return true;
  return typeof value === "string"
    && value === value.trim()
    && value.length > 0
    && [...value].length <= 128
    && !/[\\/\u0000-\u001f\u007f<>:"|?*]/.test(value)
    && !/[. ]$/.test(value);
}

function hasProjectLaunchCache(folder: ProjectFolder): folder is ProjectFolder & { wslPath: string } {
  return isStoredWslPath(folder.wslPath)
    && folder.wslDistribution !== undefined
    && isStoredWslDistribution(folder.wslDistribution);
}

function projectLaunchCache(
  location: ProjectFolderLocation,
): { wslPath: string; wslDistribution: string | null } | null {
  return isStoredWslPath(location.wslPath)
    && isStoredWslDistribution(location.wslDistribution)
    ? {
        wslPath: location.wslPath,
        wslDistribution: location.wslDistribution,
      }
    : null;
}

function parsedProjectLaunchCache(
  location: ProjectFolderLocation,
): { wslPath: string; wslDistribution: string | null } | null {
  return /^[A-Za-z]:\\/.test(location.path) ? null : projectLaunchCache(location);
}

function projectPathKey(path: string): string {
  const wslUnc = /^\\\\(wsl\.localhost|wsl\$)\\([^\\]+)(.*)$/i.exec(path);
  if (wslUnc) {
    return `wsl-unc:${wslUnc[2]!.toLowerCase()}${wslUnc[3] ?? ""}`;
  }
  if (path.startsWith("/")) return `wsl:${path}`;
  return `windows:${path.toLowerCase()}`;
}

function defaultProjectDirectory(): ProjectDirectory {
  return { id: DEFAULT_PROJECT_DIRECTORY_ID, name: "项目文件夹" };
}

function normalizeProjectDirectoryName(input: string): string {
  const name = input.trim();
  if (!name) throw new Error("目录名称不能为空");
  if ([...name].length > 64) throw new Error("目录名称不能超过 64 个字符");
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error("目录名称包含不支持的控制字符");
  return name;
}

function readStoredProjectDirectories(): ProjectDirectory[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PROJECT_DIRECTORIES_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [defaultProjectDirectory()];
    const ids = new Set<string>();
    const directories = parsed.filter((value): value is ProjectDirectory => {
      if (!value || typeof value !== "object") return false;
      const candidate = value as Partial<ProjectDirectory>;
      if (typeof candidate.id !== "string" || typeof candidate.name !== "string" || !candidate.id) {
        return false;
      }
      try {
        candidate.name = normalizeProjectDirectoryName(candidate.name);
      } catch {
        return false;
      }
      if (ids.has(candidate.id)) return false;
      ids.add(candidate.id);
      return true;
    }).slice(0, 50);
    return directories.length > 0 ? directories : [defaultProjectDirectory()];
  } catch {
    return [defaultProjectDirectory()];
  }
}

function saveProjectDirectories(next: ProjectDirectory[]): void {
  localStorage.setItem(PROJECT_DIRECTORIES_STORAGE_KEY, JSON.stringify(next));
  projectDirectories = next;
}

function readStoredProjectFolders(): ProjectFolder[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PROJECT_FOLDERS_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    const ids = new Set<string>();
    const paths = new Set<string>();
    return parsed.filter((value): value is ProjectFolder => {
      if (!value || typeof value !== "object") return false;
      const candidate = value as Partial<ProjectFolder>;
      if (
        typeof candidate.id !== "string" ||
        typeof candidate.name !== "string" ||
        typeof candidate.path !== "string" ||
        !candidate.id ||
        !candidate.name.trim() ||
        /[\u0000-\u001f\u007f]/.test(candidate.name)
      ) return false;
      candidate.name = candidate.name.trim();
      candidate.path = candidate.path.trim();
      candidate.directoryId = typeof candidate.directoryId === "string"
        && projectDirectories.some((directory) => directory.id === candidate.directoryId)
        ? candidate.directoryId
        : projectDirectories[0]!.id;
      if (!isStoredProjectPath(candidate.path)) return false;
      if (!hasProjectLaunchCache(candidate as ProjectFolder)) {
        delete candidate.wslPath;
        delete candidate.wslDistribution;
      }
      const normalizedPath = projectPathKey(candidate.path);
      if (ids.has(candidate.id) || paths.has(normalizedPath)) return false;
      ids.add(candidate.id);
      paths.add(normalizedPath);
      return true;
    }).slice(0, 100);
  } catch {
    return [];
  }
}

function saveProjectFolders(next: ProjectFolder[]): void {
  localStorage.setItem(PROJECT_FOLDERS_STORAGE_KEY, JSON.stringify(next));
  projectFolders = next;
}

function createProjectFolderId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function selfAvatarSource(): string {
  return customAvatar ?? selfAvatar;
}

appRoot.innerHTML = `
  <main class="app-shell" id="app-shell">
    <header class="xp-titlebar" id="window-drag-region">
      <div class="window-title">
        <img class="title-icon" id="title-avatar" src="${selfAvatarSource()}" alt="" draggable="false" />
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
          <button class="self-avatar-button" id="self-avatar-button" type="button" title="更换头像" aria-label="更换头像">
            <span class="avatar-frame avatar-large">
              <img id="self-avatar" src="${selfAvatarSource()}" alt="小鲸的头像" draggable="false" />
              <span class="presence-dot online" aria-label="在线"></span>
            </span>
          </button>
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
          <span class="tool-separator zoom-separator"></span>
          <button class="tool-button" id="zoom-out" title="缩小页面" aria-label="缩小页面">${icon("ZoomOut", 15)}</button>
          <button class="zoom-level" id="zoom-reset" title="恢复 100%" aria-label="当前缩放 ${Math.round(currentZoom * 100)}%，点击恢复 100%">${Math.round(currentZoom * 100)}%</button>
          <button class="tool-button" id="zoom-in" title="放大页面" aria-label="放大页面">${icon("ZoomIn", 15)}</button>
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
          <button class="tool-button terminal-only-control" id="terminal-rename" title="重命名终端" aria-label="重命名终端">${icon("Pencil", 15)}</button>
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
    <div class="dialog-backdrop" id="avatar-dialog" hidden>
      <section class="xp-dialog avatar-dialog" role="dialog" aria-modal="true" aria-labelledby="avatar-dialog-title">
        <div class="dialog-titlebar"><span id="avatar-dialog-title">自定义头像</span><button type="button" id="avatar-dialog-close" aria-label="关闭">${icon("X", 12)}</button></div>
        <div class="avatar-dialog-body">
          <div class="avatar-preview-frame"><img id="avatar-preview" src="${selfAvatarSource()}" alt="头像预览" /></div>
          <div class="avatar-picker-actions">
            <button class="xp-button" type="button" id="avatar-choose">选择图片...</button>
            <button class="xp-button" type="button" id="avatar-default">恢复默认</button>
            <input id="avatar-file-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" hidden />
            <p id="avatar-file-name">${customAvatar ? "自定义头像" : "默认头像"}</p>
            <p class="dialog-field-error" id="avatar-error" role="alert"></p>
          </div>
        </div>
        <div class="dialog-actions">
          <button class="xp-button" type="button" id="avatar-cancel">取消</button>
          <button class="xp-button default" type="button" id="avatar-save">保存</button>
        </div>
      </section>
    </div>
    <div class="dialog-backdrop" id="terminal-rename-dialog" hidden>
      <section class="xp-dialog rename-terminal-dialog" role="dialog" aria-modal="true" aria-labelledby="terminal-rename-title">
        <form id="terminal-rename-form">
          <div class="dialog-titlebar"><span id="terminal-rename-title">重命名 WSL 终端</span><button type="button" id="terminal-rename-close" aria-label="关闭">${icon("X", 12)}</button></div>
          <div class="dialog-body rename-terminal-body">
            <label for="terminal-name-input">终端名称</label>
            <input id="terminal-name-input" type="text" maxlength="24" autocomplete="off" spellcheck="false" />
            <p class="dialog-field-error" id="terminal-rename-error" role="alert"></p>
          </div>
          <div class="dialog-actions">
            <button class="xp-button" type="button" id="terminal-rename-cancel">取消</button>
            <button class="xp-button default" type="submit">保存</button>
          </div>
        </form>
      </section>
    </div>
    <div class="dialog-backdrop" id="project-directory-dialog" hidden>
      <section class="xp-dialog rename-terminal-dialog project-directory-dialog" role="dialog" aria-modal="true" aria-labelledby="project-directory-title">
        <form id="project-directory-form">
          <div class="dialog-titlebar"><span id="project-directory-title">新建项目目录</span><button type="button" id="project-directory-close" aria-label="关闭">${icon("X", 12)}</button></div>
          <div class="dialog-body rename-terminal-body">
            <label for="project-directory-name-input">目录名称</label>
            <input id="project-directory-name-input" type="text" maxlength="64" autocomplete="off" spellcheck="false" />
            <p class="dialog-field-error" id="project-directory-error" role="alert"></p>
          </div>
          <div class="dialog-actions">
            <button class="xp-button" type="button" id="project-directory-cancel">取消</button>
            <button class="xp-button default" type="submit" id="project-directory-submit">创建</button>
          </div>
        </form>
      </section>
    </div>
    <div class="dialog-backdrop" id="project-folder-dialog" hidden>
      <section class="xp-dialog project-folder-dialog" role="dialog" aria-modal="true" aria-labelledby="project-folder-title">
        <form id="project-folder-form">
          <div class="dialog-titlebar"><span id="project-folder-title">添加项目文件夹</span><button type="button" id="project-folder-close" aria-label="关闭">${icon("X", 12)}</button></div>
          <div class="dialog-body project-folder-dialog-body">
            <label for="project-folder-path">项目文件夹路径</label>
            <input id="project-folder-path" type="text" maxlength="1024" autocomplete="off" spellcheck="false" placeholder="\\\\wsl.localhost\\Ubuntu\\home\\beluga\\project" />
            <p class="dialog-field-error" id="project-folder-error" role="alert"></p>
          </div>
          <div class="dialog-actions">
            <button class="xp-button" type="button" id="project-folder-cancel">取消</button>
            <button class="xp-button default" type="submit" id="project-folder-submit">添加并进入</button>
          </div>
        </form>
      </section>
    </div>
    <div class="dialog-backdrop" id="project-rename-dialog" hidden>
      <section class="xp-dialog rename-terminal-dialog project-rename-dialog" role="dialog" aria-modal="true" aria-labelledby="project-rename-title">
        <form id="project-rename-form">
          <div class="dialog-titlebar"><span id="project-rename-title">修改项目名称</span><button type="button" id="project-rename-close" aria-label="关闭">${icon("X", 12)}</button></div>
          <div class="dialog-body rename-terminal-body">
            <label for="project-name-input">项目名称</label>
            <input id="project-name-input" type="text" maxlength="64" autocomplete="off" spellcheck="false" />
            <p class="dialog-field-error" id="project-rename-error" role="alert"></p>
          </div>
          <div class="dialog-actions">
            <button class="xp-button" type="button" id="project-rename-cancel">取消</button>
            <button class="xp-button default" type="submit">保存</button>
          </div>
        </form>
      </section>
    </div>
    <div class="dialog-backdrop" id="project-remove-dialog" hidden>
      <section class="xp-dialog project-remove-dialog" role="alertdialog" aria-modal="true" aria-labelledby="project-remove-title" aria-describedby="project-remove-message">
        <div class="dialog-titlebar"><span id="project-remove-title">确认移除项目文件夹</span><button type="button" id="project-remove-close" aria-label="关闭">${icon("X", 12)}</button></div>
        <div class="dialog-body project-remove-dialog-body">
          <strong id="project-remove-name"></strong>
          <p id="project-remove-path"></p>
          <p id="project-remove-message">只会移除群组中的记录，不会删除文件夹或其中的文件。</p>
        </div>
        <div class="dialog-actions">
          <button class="xp-button" type="button" id="project-remove-cancel">取消</button>
          <button class="xp-button default danger" type="button" id="project-remove-confirm">移除</button>
        </div>
      </section>
    </div>
    <div class="dialog-backdrop" id="about-dialog" hidden>
      <section class="xp-dialog" role="dialog" aria-modal="true" aria-labelledby="about-title">
        <div class="dialog-titlebar"><span id="about-title">关于 OICQ 2003</span><button id="dialog-close" aria-label="关闭">${icon("X", 12)}</button></div>
        <div class="dialog-body">
          <img id="about-avatar" src="${selfAvatarSource()}" alt="OICQ 用户头像" />
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
const terminalRenameDialog = query<HTMLDivElement>("#terminal-rename-dialog");
const terminalNameInput = query<HTMLInputElement>("#terminal-name-input");
const terminalRenameError = query<HTMLParagraphElement>("#terminal-rename-error");
const projectDirectoryDialog = query<HTMLDivElement>("#project-directory-dialog");
const projectDirectoryNameInput = query<HTMLInputElement>("#project-directory-name-input");
const projectDirectoryError = query<HTMLParagraphElement>("#project-directory-error");
const projectFolderDialog = query<HTMLDivElement>("#project-folder-dialog");
const projectFolderPathInput = query<HTMLInputElement>("#project-folder-path");
const projectFolderError = query<HTMLParagraphElement>("#project-folder-error");
const projectFolderSubmit = query<HTMLButtonElement>("#project-folder-submit");
const projectRenameDialog = query<HTMLDivElement>("#project-rename-dialog");
const projectNameInput = query<HTMLInputElement>("#project-name-input");
const projectRenameError = query<HTMLParagraphElement>("#project-rename-error");
const projectRemoveDialog = query<HTMLDivElement>("#project-remove-dialog");
const aboutDialog = query<HTMLDivElement>("#about-dialog");
const avatarDialog = query<HTMLDivElement>("#avatar-dialog");
const avatarPreview = query<HTMLImageElement>("#avatar-preview");
const avatarFileInput = query<HTMLInputElement>("#avatar-file-input");
const avatarError = query<HTMLParagraphElement>("#avatar-error");

function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

function projectContactId(projectId: string): string {
  return `${PROJECT_CONTACT_PREFIX}${projectId}`;
}

function projectIdFromContactId(contactId: string | undefined): string | null {
  return contactId?.startsWith(PROJECT_CONTACT_PREFIX)
    ? contactId.slice(PROJECT_CONTACT_PREFIX.length)
    : null;
}

function projectFolderForContact(contactId = snapshot?.activeContactId): ProjectFolder | null {
  const projectId = projectIdFromContactId(contactId);
  return projectId ? projectFolders.find((folder) => folder.id === projectId) ?? null : null;
}

function isProjectContact(contactId = snapshot?.activeContactId): boolean {
  return projectIdFromContactId(contactId) !== null;
}

function isTerminalContact(contactId = snapshot?.activeContactId): boolean {
  return isProjectContact(contactId)
    || contactId === TERMINAL_CONTACT_ID
    || /^terminal-\d+$/.test(contactId ?? "");
}

function projectFolderContact(folder: ProjectFolder): Contact {
  const directory = projectDirectories.find((item) => item.id === folder.directoryId);
  return {
    id: projectContactId(folder.id),
    displayName: folder.name,
    account: folder.path,
    avatarSeed: "terminal",
    presence: "online",
    statusMessage: "Windows / WSL 项目文件夹",
    group: directory?.name ?? "项目文件夹",
    unreadCount: 0,
    lastMessage: "",
    lastMessageAt: 0,
  };
}

function syncProjectFolderContacts(): void {
  snapshot.contacts = snapshot.contacts
    .filter((contact) => !isProjectContact(contact.id))
    .concat(projectFolders.map(projectFolderContact));
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

async function writeClipboardText(text: string): Promise<void> {
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

async function copyTerminalSelection(pane: TerminalPaneRuntime): Promise<void> {
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

async function pasteTerminalClipboard(pane: TerminalPaneRuntime): Promise<void> {
  try {
    if (!navigator.clipboard?.readText) throw new Error("当前环境不支持读取剪贴板");
    const text = await navigator.clipboard.readText();
    if (text) pane.terminal.paste(text);
  } catch (error) {
    showToast(error instanceof Error ? error.message : "粘贴终端内容失败");
  } finally {
    pane.terminal.focus();
  }
}

function handleTerminalClipboardShortcut(
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

function terminalWorkspace(
  contactId = snapshot?.activeContactId,
  create = false,
): TerminalWorkspace | null {
  if (!contactId || !isTerminalContact(contactId)) return null;
  let workspace = terminalWorkspaces.get(contactId);
  if (!workspace && create) {
    workspace = {
      contactId,
      projectFolder: projectFolderForContact(contactId),
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

function activeTerminalPane(
  workspace = terminalWorkspace(),
): TerminalPaneRuntime | null {
  return !workspace || workspace.activePaneId === null
    ? null
    : workspace.panes.get(workspace.activePaneId) ?? null;
}

function terminalPaneIds(
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
  pane.element.classList.toggle(
    "is-active",
    pane.id === pane.workspace.activePaneId,
  );
}

function terminalPanePosition(
  paneId: number,
  workspace = terminalWorkspace(),
): number {
  const position = terminalPaneIds(workspace?.layout ?? null).indexOf(paneId);
  return position < 0 ? 1 : position + 1;
}

function updateTerminalToolbarState(): void {
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
    const contactName = getActiveContact().displayName;
    query("#conversation-caption").textContent =
      paneCount > 1 ? `${contactName} · ${paneCount} 个窗格` : `${contactName}会话`;
  }
}

function updateTerminalConnectionStatus(): void {
  if (!snapshot?.activeContactId || !isTerminalContact()) return;
  const workspace = terminalWorkspace();
  const pane = activeTerminalPane(workspace);
  if (!pane) {
    query("#connection-status").textContent = "正在启动 WSL 终端...";
    updateTypingStatus();
    return;
  }
  const contactName = getActiveContact().displayName;
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
  updateTypingStatus();
}

function setActiveTerminalPane(pane: TerminalPaneRuntime, focus = false): void {
  const { workspace } = pane;
  if (pane.disposed || workspace.panes.get(pane.id) !== pane) return;
  workspace.activePaneId = pane.id;
  workspace.panes.forEach(updateTerminalPaneVisual);
  if (snapshot?.activeContactId === workspace.contactId) {
    updateTerminalToolbarState();
    updateTerminalConnectionStatus();
    updateSendState();
  }
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

function renderTerminalLayoutNode(
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

function renderTerminalLayout(workspace: TerminalWorkspace): void {
  if (snapshot?.activeContactId !== workspace.contactId) return;
  const ids = terminalPaneIds(workspace.layout);
  terminalHost.classList.toggle("is-split", ids.length > 1);
  if (workspace.layout) {
    terminalHost.replaceChildren(renderTerminalLayoutNode(workspace.layout, workspace));
  }
  else terminalHost.replaceChildren();
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
  if (
    pane.disposed ||
    !pane.mounted ||
    terminalHost.hidden ||
    snapshot?.activeContactId !== pane.workspace.contactId
  ) return;
  if (pane.surface.clientWidth < 2 || pane.surface.clientHeight < 2) return;
  try {
    pane.fit.fit();
  } catch {
    // Layout transitions can expose a zero-sized pane for one animation frame.
  }
}

function fitAllTerminalPanes(workspace = terminalWorkspace()): void {
  if (!workspace || snapshot?.activeContactId !== workspace.contactId) return;
  workspace.panes.forEach(resizeTerminalPaneToFit);
}

function scheduleTerminalFit(workspace = terminalWorkspace()): void {
  if (!workspace || workspace.fitFrame !== null) return;
  workspace.fitFrame = requestAnimationFrame(() => {
    workspace.fitFrame = null;
    fitAllTerminalPanes(workspace);
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
  if (snapshot?.activeContactId === pane.workspace.contactId) {
    updateTerminalToolbarState();
    updateTerminalConnectionStatus();
  }
}

function cacheProjectFolderResolution(
  workspace: TerminalWorkspace,
  location: ProjectFolderLocation,
): void {
  const folder = workspace.projectFolder;
  const cache = projectLaunchCache(location);
  if (!folder || !cache) return;
  const current = projectFolders.find((item) => item.id === folder.id);
  if (!current) return;

  const updated: ProjectFolder = {
    ...current,
    path: location.path,
    ...cache,
  };
  try {
    saveProjectFolders(projectFolders.map((item) => item.id === updated.id ? updated : item));
  } catch {
    return;
  }
  workspace.projectFolder = updated;
  syncProjectFolderContacts();
  renderContacts();
  if (snapshot.activeContactId === workspace.contactId) renderChatHeader();
}

async function openTerminalPane(pane: TerminalPaneRuntime): Promise<void> {
  if (!isTauriRuntime() || pane.disposed || pane.sessionId) return;
  if (pane.openPromise) return pane.openPromise;
  const generation = ++pane.generation;
  pane.state = "opening";
  updateTerminalPaneVisual(pane);
  if (snapshot?.activeContactId === pane.workspace.contactId) {
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
        ) pane.terminal.write(ptyBytes(data));
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
    if (opened.project) cacheProjectFolderResolution(pane.workspace, opened.project);
    pane.state = "connected";
    updateTerminalPaneVisual(pane);
    resizeTerminalPaneToFit(pane);
    if (earlyExit) handleTerminalPaneExit(pane, generation, earlyExit);
    if (snapshot?.activeContactId === pane.workspace.contactId) {
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
      if (snapshot?.activeContactId === pane.workspace.contactId) {
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

function createTerminalPane(workspace: TerminalWorkspace): TerminalPaneRuntime {
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
  const pane: TerminalPaneRuntime = {
    workspace,
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
  terminal.attachCustomKeyEventHandler((event) => handleTerminalClipboardShortcut(pane, event));
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

function ensureTerminal(
  focus = true,
  contactId = snapshot?.activeContactId,
): TerminalPaneRuntime | null {
  const workspace = terminalWorkspace(contactId, true);
  if (!workspace || snapshot?.activeContactId !== workspace.contactId) return null;
  terminalHost.hidden = false;
  transcript.hidden = true;
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

async function splitActiveTerminal(direction: TerminalSplitDirection): Promise<void> {
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

async function disposeTerminalWorkspace(contactId: string): Promise<void> {
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

async function closeTerminalPane(pane: TerminalPaneRuntime): Promise<void> {
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

async function restartTerminalPaneNow(pane: TerminalPaneRuntime): Promise<void> {
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
  if (snapshot?.activeContactId === pane.workspace.contactId) {
    updateTerminalToolbarState();
    updateTerminalConnectionStatus();
  }
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
  if (contact.avatarSeed === "self") return selfAvatarSource();
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

function showToast(text: string, placement: "bottom-right" | "top-right" = "bottom-right"): void {
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toast.textContent = text;
  toast.classList.toggle("is-top-right", placement === "top-right");
  toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
    toast.classList.remove("is-top-right");
    toastTimer = null;
  }, 2200);
}

function updateZoomControls(): void {
  const index = ZOOM_LEVELS.indexOf(currentZoom);
  const percentage = Math.round(currentZoom * 100);
  const reset = query<HTMLButtonElement>("#zoom-reset");
  reset.textContent = `${percentage}%`;
  reset.setAttribute("aria-label", `当前缩放 ${percentage}%，点击恢复 100%`);
  query<HTMLButtonElement>("#zoom-out").disabled = index <= 0;
  query<HTMLButtonElement>("#zoom-in").disabled = index >= ZOOM_LEVELS.length - 1;
}

async function applyPageZoom(scale: number, announce = true): Promise<void> {
  currentZoom = ZOOM_LEVELS.includes(scale) ? scale : 1;
  updateZoomControls();
  try {
    localStorage.setItem(ZOOM_STORAGE_KEY, String(currentZoom));
  } catch {
    if (announce) showToast("无法保存缩放设置");
  }

  try {
    if (isTauriRuntime()) {
      await getCurrentWebview().setZoom(currentZoom);
    } else {
      shell.style.setProperty("zoom", String(currentZoom));
    }
    requestAnimationFrame(() => scheduleTerminalFit());
    if (announce) showToast(`页面缩放：${Math.round(currentZoom * 100)}%`);
  } catch (error) {
    if (announce) showToast(error instanceof Error ? error.message : "页面缩放失败");
  }
}

function changePageZoom(step: -1 | 1): void {
  const index = ZOOM_LEVELS.indexOf(currentZoom);
  const nextIndex = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, index + step));
  if (nextIndex !== index) void applyPageZoom(ZOOM_LEVELS[nextIndex]);
}

function updateAvatarUi(): void {
  const source = selfAvatarSource();
  query<HTMLImageElement>("#self-avatar").src = source;
  query<HTMLImageElement>("#title-avatar").src = source;
  query<HTMLImageElement>("#about-avatar").src = source;
  if (snapshot) {
    renderContacts();
    if (snapshot.activeContactId === snapshot.currentUser.id) renderChatHeader();
  }
}

function openAvatarDialog(): void {
  pendingAvatar = customAvatar;
  avatarPreview.src = pendingAvatar ?? selfAvatar;
  avatarFileInput.value = "";
  query("#avatar-file-name").textContent = pendingAvatar ? "自定义头像" : "默认头像";
  avatarError.textContent = "";
  popupMenu.hidden = true;
  avatarDialog.hidden = false;
  query<HTMLButtonElement>("#avatar-choose").focus();
}

function closeAvatarDialog(restoreFocus = true): void {
  avatarDialog.hidden = true;
  avatarFileInput.value = "";
  avatarError.textContent = "";
  if (restoreFocus) query<HTMLButtonElement>("#self-avatar-button").focus();
}

async function createAvatarFromFile(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp|gif|bmp)$/i.test(file.type)) {
    throw new Error("请选择 PNG、JPG、WebP、GIF 或 BMP 图片");
  }
  if (file.size > 10 * 1024 * 1024) throw new Error("图片不能超过 10 MB");

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = document.createElement("img");
    image.src = objectUrl;
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("无法读取这张图片"));
    });
    if (!image.naturalWidth || !image.naturalHeight) throw new Error("图片尺寸无效");

    const size = Math.min(image.naturalWidth, image.naturalHeight);
    const sourceX = (image.naturalWidth - size) / 2;
    const sourceY = (image.naturalHeight - size) / 2;
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前环境无法处理图片");
    context.drawImage(image, sourceX, sourceY, size, size, 0, 0, 256, 256);
    return canvas.toDataURL("image/webp", 0.86);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function selectAvatarFile(file: File | undefined): Promise<void> {
  if (!file) return;
  avatarError.textContent = "";
  try {
    pendingAvatar = await createAvatarFromFile(file);
    avatarPreview.src = pendingAvatar;
    query("#avatar-file-name").textContent = file.name;
  } catch (error) {
    avatarError.textContent = error instanceof Error ? error.message : "头像处理失败";
  }
}

function saveAvatar(): void {
  try {
    if (pendingAvatar) localStorage.setItem(AVATAR_STORAGE_KEY, pendingAvatar);
    else localStorage.removeItem(AVATAR_STORAGE_KEY);
  } catch {
    avatarError.textContent = "无法保存头像，本地存储空间不足";
    return;
  }
  customAvatar = pendingAvatar;
  updateAvatarUi();
  closeAvatarDialog(false);
  query<HTMLButtonElement>("#self-avatar-button").focus();
  showToast(customAvatar ? "头像已更新" : "已恢复默认头像");
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
    if (isProjectContact(contact.id)) return false;
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
  if (isTerminalContact(contact.id)) button.classList.add("terminal-contact");
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
  if (isTerminalContact(contact.id)) {
    button.addEventListener("dblclick", (event) => {
      event.preventDefault();
      openRenameTerminal(contact.id);
    });
  }
  return button;
}

function projectFolderRow(folder: ProjectFolder): HTMLElement {
  const contactId = projectContactId(folder.id);
  const wrapper = document.createElement("div");
  wrapper.className = "project-folder-row-wrap project-directory-child";
  wrapper.dataset.projectId = folder.id;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "project-folder-row";
  if (contactId === snapshot.activeContactId) button.classList.add("selected");
  button.dataset.projectId = folder.id;
  button.setAttribute("role", "option");
  button.setAttribute("aria-selected", String(contactId === snapshot.activeContactId));
  button.title = folder.path;

  const folderIcon = document.createElement("span");
  folderIcon.className = "project-folder-icon";
  folderIcon.innerHTML = icon(contactId === snapshot.activeContactId ? "FolderOpen" : "Folder", 22);
  const copy = document.createElement("span");
  copy.className = "project-folder-copy";
  const name = document.createElement("strong");
  name.textContent = folder.name;
  const path = document.createElement("span");
  path.textContent = folder.path;
  copy.append(name, path);
  button.append(folderIcon, copy);
  button.addEventListener("click", (event) => {
    if (event.detail <= 1) void selectProjectFolder(folder.id);
  });
  button.addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void openProjectFolderInOneCommander(folder);
  });

  const menuButton = document.createElement("button");
  menuButton.type = "button";
  menuButton.className = "project-row-menu";
  menuButton.title = "项目菜单";
  menuButton.setAttribute("aria-label", `${folder.name}的项目菜单`);
  menuButton.setAttribute("aria-haspopup", "menu");
  menuButton.innerHTML = icon("MoreHorizontal", 16);
  menuButton.addEventListener("click", () => showProjectFolderMenu(folder, menuButton));

  const openContextMenu = (event: MouseEvent | KeyboardEvent) => {
    event.preventDefault();
    button.focus();
    if (event instanceof MouseEvent) {
      showProjectFolderMenu(folder, button, event.clientX, event.clientY);
    } else {
      showProjectFolderMenu(folder, button);
    }
  };
  wrapper.addEventListener("contextmenu", openContextMenu);
  button.addEventListener("keydown", (event) => {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      openContextMenu(event);
    }
  });
  wrapper.append(button, menuButton);
  return wrapper;
}

function renderProjectFolders(): void {
  const toolbar = document.createElement("div");
  toolbar.className = "project-directory-toolbar";
  const toolbarLabel = document.createElement("strong");
  toolbarLabel.textContent = "项目目录";
  const toolbarCount = document.createElement("span");
  toolbarCount.textContent = String(projectDirectories.length);
  const createButton = document.createElement("button");
  createButton.type = "button";
  createButton.id = "add-project-directory";
  createButton.title = "新建项目目录";
  createButton.setAttribute("aria-label", "新建项目目录");
  createButton.innerHTML = icon("Plus", 14);
  createButton.addEventListener("click", () => openProjectDirectoryDialog());
  toolbar.append(toolbarLabel, toolbarCount, createButton);
  contactList.append(toolbar);

  const normalized = filterText.trim().toLocaleLowerCase();
  projectDirectories.forEach((directory) => {
    const directoryFolders = projectFolders.filter((folder) => folder.directoryId === directory.id);
    const directoryMatches = directory.name.toLocaleLowerCase().includes(normalized);
    const visibleFolders = directoryFolders.filter((folder) => (
      !normalized || directoryMatches || `${folder.name} ${folder.path}`.toLocaleLowerCase().includes(normalized)
    ));
    const collapseKey = `project-directory:${directory.id}`;
    const collapsed = collapsedGroups.has(collapseKey);
    const groupRow = document.createElement("div");
    groupRow.className = "group-header-row project-group-header project-directory-header";
    groupRow.dataset.directoryId = directory.id;

    const groupButton = document.createElement("button");
    groupButton.type = "button";
    groupButton.className = "group-header";
    groupButton.setAttribute("aria-expanded", String(!collapsed));
    groupButton.innerHTML = `<span class="tree-arrow">${collapsed ? "▶" : "▼"}</span><span></span><em>${directoryFolders.length}</em>`;
    groupButton.querySelector("span:nth-child(2)")!.textContent = directory.name;
    groupButton.addEventListener("click", () => {
      if (collapsed) collapsedGroups.delete(collapseKey);
      else collapsedGroups.add(collapseKey);
      renderContacts();
    });
    groupButton.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      showProjectDirectoryMenu(directory, groupButton, event.clientX, event.clientY);
    });
    groupButton.addEventListener("keydown", (event) => {
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault();
        showProjectDirectoryMenu(directory, groupButton);
      }
    });

    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "group-add-terminal group-add-project";
    addButton.title = `向“${directory.name}”添加项目`;
    addButton.setAttribute("aria-label", `向“${directory.name}”添加项目`);
    addButton.innerHTML = icon("Plus", 13);
    addButton.addEventListener("click", () => openProjectFolderDialog(directory.id));

    const menuButton = document.createElement("button");
    menuButton.type = "button";
    menuButton.className = "project-directory-menu";
    menuButton.title = "目录菜单";
    menuButton.setAttribute("aria-label", `${directory.name}的目录菜单`);
    menuButton.setAttribute("aria-haspopup", "menu");
    menuButton.innerHTML = icon("MoreHorizontal", 15);
    menuButton.addEventListener("click", () => showProjectDirectoryMenu(directory, menuButton));
    groupRow.append(groupButton, addButton, menuButton);
    contactList.append(groupRow);

    if (collapsed) return;
    if (visibleFolders.length === 0) {
      const empty = document.createElement("div");
      empty.className = "project-directory-empty";
      empty.textContent = directoryFolders.length === 0 ? "此目录暂无项目" : "没有匹配的项目";
      contactList.append(empty);
      return;
    }
    visibleFolders.forEach((folder) => contactList.append(projectFolderRow(folder)));
  });
}

function renderContacts(): void {
  contactList.replaceChildren();
  if (activeTab === "groups") {
    renderProjectFolders();
    refreshIcons();
    return;
  }
  const contacts = filteredContacts();

  if (contacts.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-roster";
    empty.textContent = "没有找到联系人";
    contactList.append(empty);
    return;
  }

  if (activeTab === "recent") {
    contacts.forEach((contact) => contactList.append(contactRow(contact)));
    return;
  }

  const grouped = new Map<string, Contact[]>();
  contacts.forEach((contact) => {
    const groupName = contact.group;
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
    if (groupName === "工具") {
      const groupRow = document.createElement("div");
      groupRow.className = "group-header-row";
      const addTerminalButton = document.createElement("button");
      addTerminalButton.type = "button";
      addTerminalButton.className = "group-add-terminal";
      addTerminalButton.title = "新建独立 WSL 终端";
      addTerminalButton.setAttribute("aria-label", "新建独立 WSL 终端");
      addTerminalButton.innerHTML = icon("Plus", 13);
      addTerminalButton.addEventListener("click", () => void addTerminalContact());
      groupRow.append(groupButton, addTerminalButton);
      contactList.append(groupRow);
    } else {
      contactList.append(groupButton);
    }
    if (!collapsed) items.forEach((contact) => contactList.append(contactRow(contact)));
  });
  refreshIcons();
}

function renderChatHeader(): void {
  const contact = getActiveContact();
  const terminalMode = isTerminalContact(contact.id);
  const projectFolder = projectFolderForContact(contact.id);
  chatPane.classList.toggle("terminal-mode", terminalMode);
  terminalHost.hidden = !terminalMode;
  transcript.hidden = terminalMode;
  query("#chat-contact-name").textContent = contact.displayName;
  query("#chat-presence").textContent = projectFolder
    ? "[项目]"
    : terminalMode
      ? "[WSL]"
      : `[${presenceText[contact.presence]}]`;
  query("#chat-account").textContent = contact.account;
  query("#chat-signature").textContent = projectFolder
    ? "项目文件夹 · WSL 终端从此目录启动"
    : terminalMode
      ? "WSL2 默认发行版 · 支持 ANSI、交互程序与 Codex 流式输出"
      : contact.statusMessage;
  query("#conversation-caption").textContent = projectFolder
    ? "项目终端会话"
    : terminalMode
      ? "WSL 终端会话"
      : `正在与 ${contact.displayName} 交谈`;
  query<HTMLElement>("#terminal-badge").hidden = !terminalMode;
  query("#terminal-badge span").textContent = projectFolder ? "PROJECT SHELL" : "WSL SHELL";
  document.querySelectorAll<HTMLElement>(".terminal-only-control").forEach((control) => {
    control.hidden = !terminalMode;
  });
  query<HTMLElement>("#terminal-rename").hidden = !terminalMode || Boolean(projectFolder);
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
    const workspace = terminalWorkspace();
    const pane = activeTerminalPane(workspace);
    const contactName = getActiveContact().displayName;
    const label = pane
      ? workspace && workspace.panes.size > 1
        ? `${contactName} · 窗格 ${terminalPanePosition(pane.id, workspace)}/${workspace.panes.size}`
        : contactName
      : contactName;
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
    const workspace = terminalWorkspace();
    const pane = activeTerminalPane(workspace);
    const paneLabel = pane && workspace && workspace.panes.size > 1
      ? ` · 发送到窗格 ${terminalPanePosition(pane.id, workspace)}`
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

function projectDirectoryHeader(directoryId: string): HTMLElement | null {
  return contactList.querySelector<HTMLElement>(
    `.project-directory-header[data-directory-id="${CSS.escape(directoryId)}"]`,
  );
}

function openProjectDirectoryDialog(directoryId: string | null = null): void {
  const directory = directoryId
    ? projectDirectories.find((item) => item.id === directoryId) ?? null
    : null;
  editingProjectDirectoryId = directory?.id ?? null;
  query("#project-directory-title").textContent = directory ? "重命名项目目录" : "新建项目目录";
  query("#project-directory-submit").textContent = directory ? "保存" : "创建";
  projectDirectoryNameInput.value = directory?.name ?? "";
  projectDirectoryError.textContent = "";
  popupMenu.hidden = true;
  projectDirectoryDialog.hidden = false;
  requestAnimationFrame(() => {
    projectDirectoryNameInput.focus();
    if (directory) projectDirectoryNameInput.select();
  });
}

function closeProjectDirectoryDialog(restoreFocus = true): void {
  const directoryId = editingProjectDirectoryId;
  projectDirectoryDialog.hidden = true;
  projectDirectoryNameInput.value = "";
  projectDirectoryError.textContent = "";
  editingProjectDirectoryId = null;
  if (!restoreFocus) return;
  (directoryId ? projectDirectoryHeader(directoryId) : null)
    ?.querySelector<HTMLButtonElement>(".group-header")?.focus();
  if (!directoryId) document.querySelector<HTMLButtonElement>("#add-project-directory")?.focus();
}

function saveProjectDirectory(): void {
  try {
    const name = normalizeProjectDirectoryName(projectDirectoryNameInput.value);
    const duplicate = projectDirectories.some((directory) => (
      directory.id !== editingProjectDirectoryId
      && directory.name.toLocaleLowerCase() === name.toLocaleLowerCase()
    ));
    if (duplicate) throw new Error("已存在同名项目目录");

    if (editingProjectDirectoryId) {
      const directoryId = editingProjectDirectoryId;
      if (!projectDirectories.some((directory) => directory.id === directoryId)) {
        closeProjectDirectoryDialog(false);
        return;
      }
      saveProjectDirectories(projectDirectories.map((directory) => (
        directory.id === directoryId ? { ...directory, name } : directory
      )));
      closeProjectDirectoryDialog(false);
      syncProjectFolderContacts();
      renderContacts();
      projectDirectoryHeader(directoryId)?.querySelector<HTMLButtonElement>(".group-header")?.focus();
      showToast(`已将项目目录重命名为“${name}”`);
      return;
    }

    const directory: ProjectDirectory = { id: createProjectFolderId(), name };
    saveProjectDirectories([...projectDirectories, directory]);
    closeProjectDirectoryDialog(false);
    renderContacts();
    projectDirectoryHeader(directory.id)?.querySelector<HTMLButtonElement>(".group-header")?.focus();
    showToast(`已创建项目目录“${name}”`);
  } catch (error) {
    projectDirectoryError.textContent = error instanceof Error ? error.message : "无法保存项目目录";
    projectDirectoryNameInput.focus();
  }
}

function showProjectDirectoryMenu(
  directory: ProjectDirectory,
  anchor: HTMLElement,
  clientX?: number,
  clientY?: number,
): void {
  const items: MenuItem[] = [
    { label: "添加项目文件夹", action: () => openProjectFolderDialog(directory.id) },
    { separator: true, label: "" },
    { label: "重命名目录", action: () => openProjectDirectoryDialog(directory.id) },
  ];
  if (clientX !== undefined && clientY !== undefined) showPopupAt(clientX, clientY, items);
  else showPopup(anchor, items);
}

function openProjectFolderDialog(directoryId: string): void {
  const directory = projectDirectories.find((item) => item.id === directoryId);
  if (!directory) {
    showToast("项目目录不存在");
    return;
  }
  pendingProjectDirectoryId = directory.id;
  query("#project-folder-title").textContent = `向“${directory.name}”添加项目`;
  projectFolderPathInput.value = "";
  projectFolderError.textContent = "";
  projectFolderSubmit.disabled = false;
  popupMenu.hidden = true;
  projectFolderDialog.hidden = false;
  requestAnimationFrame(() => projectFolderPathInput.focus());
}

function closeProjectFolderDialog(restoreFocus = true): void {
  const directoryId = pendingProjectDirectoryId;
  projectFolderDialog.hidden = true;
  projectFolderPathInput.value = "";
  projectFolderError.textContent = "";
  projectFolderSubmit.disabled = false;
  pendingProjectDirectoryId = null;
  if (restoreFocus && directoryId) {
    projectDirectoryHeader(directoryId)?.querySelector<HTMLButtonElement>(".group-add-project")?.focus();
  }
}

async function selectProjectFolder(projectId: string): Promise<void> {
  const selectionSequence = ++contactSelectionSequence;
  const folder = projectFolders.find((item) => item.id === projectId);
  if (!folder) {
    showToast("项目文件夹记录不存在");
    return;
  }
  const contactId = projectContactId(projectId);
  if (!snapshot.contacts.some((contact) => contact.id === contactId)) {
    snapshot.contacts.push(projectFolderContact(folder));
  }
  await selectContact(contactId, selectionSequence);
}

async function openProjectFolderInOneCommander(folder: ProjectFolder): Promise<void> {
  try {
    await backend.openProjectFolderInOneCommander(folder);
    showToast(`已在 OneCommander 中打开“${folder.name}”`);
  } catch (error) {
    showToast(error instanceof Error ? error.message : "无法使用 OneCommander 打开项目文件夹");
  }
}

async function addProjectFolder(): Promise<void> {
  const directoryId = pendingProjectDirectoryId;
  if (!directoryId || !projectDirectories.some((directory) => directory.id === directoryId)) {
    projectFolderError.textContent = "项目目录不存在，请重新选择";
    return;
  }
  const requestedPath = projectFolderPathInput.value.trim();
  if (!requestedPath) {
    projectFolderError.textContent = "请输入项目文件夹路径";
    projectFolderPathInput.focus();
    return;
  }
  projectFolderSubmit.disabled = true;
  projectFolderError.textContent = "";
  try {
    const location = await backend.parseProjectFolder(requestedPath);
    const launchCache = parsedProjectLaunchCache(location);
    const locationKey = projectPathKey(location.path);
    const existing = projectFolders.find((folder) => projectPathKey(folder.path) === locationKey);
    if (existing) {
      const updated: ProjectFolder = {
        ...existing,
        path: location.path,
        ...(launchCache ?? {}),
      };
      saveProjectFolders(projectFolders.map((folder) => folder.id === updated.id ? updated : folder));
      syncProjectFolderContacts();
      filterText = "";
      query<HTMLInputElement>("#contact-search").value = "";
      closeProjectFolderDialog(false);
      setTab("groups");
      collapsedGroups.delete(`project-directory:${existing.directoryId}`);
      await selectProjectFolder(updated.id);
      renderContacts();
      const existingDirectory = projectDirectories.find((item) => item.id === existing.directoryId);
      showToast(`该项目已在“${existingDirectory?.name ?? "项目目录"}”中，正在打开终端`);
      return;
    }
    const folder: ProjectFolder = {
      id: createProjectFolderId(),
      directoryId,
      name: location.name,
      path: location.path,
      ...(launchCache ?? {}),
    };
    saveProjectFolders([...projectFolders, folder]);
    syncProjectFolderContacts();
    filterText = "";
    query<HTMLInputElement>("#contact-search").value = "";
    collapsedGroups.delete(`project-directory:${directoryId}`);
    closeProjectFolderDialog(false);
    setTab("groups");
    await selectProjectFolder(folder.id);
    showToast(`已添加项目“${folder.name}”，正在打开终端`);
  } catch (error) {
    projectFolderError.textContent = error instanceof Error ? error.message : "无法添加项目文件夹";
    projectFolderPathInput.focus();
  } finally {
    projectFolderSubmit.disabled = false;
  }
}

function showProjectFolderMenu(
  folder: ProjectFolder,
  anchor: HTMLElement,
  clientX?: number,
  clientY?: number,
): void {
  const items: MenuItem[] = [
    { label: "在 OneCommander 中打开", action: () => void openProjectFolderInOneCommander(folder) },
    { separator: true, label: "" },
    { label: "修改项目名称", action: () => openProjectRenameDialog(folder.id) },
    { separator: true, label: "" },
    { label: "移除", action: () => openProjectRemovalDialog(folder.id) },
  ];
  if (clientX !== undefined && clientY !== undefined) showPopupAt(clientX, clientY, items);
  else showPopup(anchor, items);
}

function projectFolderRowButton(projectId: string): HTMLButtonElement | null {
  return contactList.querySelector<HTMLButtonElement>(
    `.project-folder-row[data-project-id="${CSS.escape(projectId)}"]`,
  );
}

function normalizeProjectFolderName(input: string): string {
  const name = input.trim();
  if (!name) throw new Error("项目名称不能为空");
  if ([...name].length > 64) throw new Error("项目名称不能超过 64 个字符");
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error("项目名称包含不支持的控制字符");
  return name;
}

function openProjectRenameDialog(projectId: string): void {
  const folder = projectFolders.find((item) => item.id === projectId);
  if (!folder) return;
  renamingProjectId = projectId;
  projectNameInput.value = folder.name;
  projectRenameError.textContent = "";
  popupMenu.hidden = true;
  projectRenameDialog.hidden = false;
  requestAnimationFrame(() => {
    projectNameInput.focus();
    projectNameInput.select();
  });
}

function closeProjectRenameDialog(restoreFocus = true): void {
  const projectId = renamingProjectId;
  projectRenameDialog.hidden = true;
  projectNameInput.value = "";
  projectRenameError.textContent = "";
  renamingProjectId = null;
  if (!restoreFocus || !projectId) return;
  (projectFolderRowButton(projectId)
    ?? document.querySelector<HTMLButtonElement>("#add-project-folder"))?.focus();
}

function renameProjectFolder(): void {
  const projectId = renamingProjectId;
  const folder = projectFolders.find((item) => item.id === projectId);
  if (!projectId || !folder) {
    closeProjectRenameDialog(false);
    return;
  }

  try {
    const name = normalizeProjectFolderName(projectNameInput.value);
    saveProjectFolders(projectFolders.map((item) => (
      item.id === projectId ? { ...item, name } : item
    )));
    const contactId = projectContactId(projectId);
    const active = snapshot.activeContactId === contactId;
    closeProjectRenameDialog(false);
    syncProjectFolderContacts();
    renderContacts();
    if (active) {
      renderChatHeader();
      updateTerminalConnectionStatus();
    }
    (projectFolderRowButton(projectId)
      ?? document.querySelector<HTMLButtonElement>("#add-project-folder"))?.focus();
    showToast(`已将项目重命名为“${name}”`);
  } catch (error) {
    projectRenameError.textContent = error instanceof Error ? error.message : "无法修改项目名称";
    projectNameInput.focus();
  }
}

function openProjectRemovalDialog(projectId: string): void {
  const folder = projectFolders.find((item) => item.id === projectId);
  if (!folder) return;
  pendingProjectRemovalId = projectId;
  query("#project-remove-name").textContent = folder.name;
  query("#project-remove-path").textContent = folder.path;
  popupMenu.hidden = true;
  projectRemoveDialog.hidden = false;
  query<HTMLButtonElement>("#project-remove-cancel").focus();
}

function closeProjectRemovalDialog(restoreFocus = true): void {
  const projectId = pendingProjectRemovalId;
  projectRemoveDialog.hidden = true;
  pendingProjectRemovalId = null;
  if (!restoreFocus || !projectId) return;
  const row = projectFolderRowButton(projectId);
  (row ?? document.querySelector<HTMLButtonElement>("#add-project-folder"))?.focus();
}

async function confirmProjectRemoval(): Promise<void> {
  const projectId = pendingProjectRemovalId;
  const folder = projectFolders.find((item) => item.id === projectId);
  if (!projectId || !folder) {
    closeProjectRemovalDialog(false);
    return;
  }
  const contactId = projectContactId(projectId);
  const next = projectFolders.filter((item) => item.id !== projectId);
  try {
    saveProjectFolders(next);
  } catch {
    showToast("无法保存项目文件夹列表");
    return;
  }
  closeProjectRemovalDialog(false);

  if (snapshot.activeContactId === contactId) {
    const fallback = snapshot.contacts.find((contact) => !isProjectContact(contact.id));
    if (fallback) await selectContact(fallback.id);
  }
  await disposeTerminalWorkspace(contactId);
  messageDrafts.delete(contactId);
  syncProjectFolderContacts();
  renderContacts();
  const focusTarget = contactList.querySelector<HTMLButtonElement>(".project-folder-row")
    ?? document.querySelector<HTMLButtonElement>("#add-project-folder");
  focusTarget?.focus();
  showToast(`已从群组移除“${folder.name}”`);
}

function openRenameTerminal(contactId = snapshot.activeContactId): void {
  if (!isTerminalContact(contactId) || isProjectContact(contactId)) return;
  const contact = snapshot.contacts.find((item) => item.id === contactId);
  if (!contact) return;
  renamingTerminalId = contactId;
  terminalNameInput.value = contact.displayName;
  terminalRenameError.textContent = "";
  popupMenu.hidden = true;
  terminalRenameDialog.hidden = false;
  requestAnimationFrame(() => {
    terminalNameInput.focus();
    terminalNameInput.select();
  });
}

function closeRenameTerminal(restoreFocus = true): void {
  terminalRenameDialog.hidden = true;
  terminalRenameError.textContent = "";
  renamingTerminalId = null;
  if (restoreFocus && isTerminalContact()) {
    query<HTMLButtonElement>("#terminal-rename").focus();
  }
}

async function renameTerminal(): Promise<void> {
  const contactId = renamingTerminalId;
  if (!contactId) return;
  const displayName = terminalNameInput.value.trim();
  if (!displayName) {
    terminalRenameError.textContent = "终端名称不能为空";
    terminalNameInput.focus();
    return;
  }
  if ([...displayName].length > 24) {
    terminalRenameError.textContent = "终端名称不能超过 24 个字符";
    terminalNameInput.focus();
    return;
  }

  try {
    const updated = await backend.renameTerminalContact(contactId, displayName);
    replaceContact(updated);
    closeRenameTerminal(false);
    renderContacts();
    if (snapshot.activeContactId === contactId) {
      renderChatHeader();
      updateTerminalConnectionStatus();
      query<HTMLButtonElement>("#terminal-rename").focus();
    }
    showToast(`已重命名为“${updated.displayName}”`);
  } catch (error) {
    terminalRenameError.textContent = error instanceof Error ? error.message : "无法重命名终端";
    terminalNameInput.focus();
  }
}

async function addTerminalContact(): Promise<void> {
  try {
    const contact = await backend.createTerminalContact();
    if (!snapshot.contacts.some((item) => item.id === contact.id)) {
      snapshot.contacts.push(contact);
    }
    filterText = "";
    query<HTMLInputElement>("#contact-search").value = "";
    collapsedGroups.delete("工具");
    if (activeTab !== "friends") setTab("friends");
    else renderContacts();
    await selectContact(contact.id);
  } catch (error) {
    showToast(error instanceof Error ? error.message : "无法新建 WSL 终端");
  }
}

async function selectContact(
  contactId: string,
  selectionSequence = ++contactSelectionSequence,
): Promise<void> {
  if (selectionSequence !== contactSelectionSequence) return;
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
  if (isProjectContact(contactId)) {
    messages = [];
    renderMessages(true);
    updateTerminalConnectionStatus();
    activeTerminalPane()?.terminal.focus();
    return;
  }
  query("#connection-status").textContent = "正在读取聊天记录...";
  try {
    const [conversation, contact] = await Promise.all([
      backend.getConversation(contactId),
      backend.markRead(contactId),
    ]);
    if (selectionSequence !== contactSelectionSequence) return;
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
    if (selectionSequence === contactSelectionSequence) {
      showToast(error instanceof Error ? error.message : "读取会话失败");
    }
  }
  if (selectionSequence === contactSelectionSequence) updateTypingStatus();
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
  popupMenu.hidden = true;
  document.querySelectorAll<HTMLButtonElement>(".roster-tab").forEach((button) => {
    const active = button.dataset.tab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  const search = query<HTMLInputElement>("#contact-search");
  const projectMode = tab === "groups";
  search.placeholder = projectMode ? "查找项目文件夹" : "查找联系人";
  search.setAttribute("aria-label", search.placeholder);
  query<HTMLButtonElement>("#add-contact").hidden = projectMode;
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

function fillPopup(items: MenuItem[]): void {
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
}

function finishPopupPosition(left: number, top: number): void {
  popupMenu.style.left = `${left}px`;
  popupMenu.style.top = `${top}px`;
  popupMenu.style.visibility = "visible";
  popupMenu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
}

function showPopup(anchor: HTMLElement, items: MenuItem[]): void {
  fillPopup(items);

  const anchorRect = anchor.getBoundingClientRect();
  const menuRect = popupMenu.getBoundingClientRect();
  const left = Math.max(3, Math.min(anchorRect.left, window.innerWidth - menuRect.width - 3));
  const preferredTop = anchorRect.bottom;
  const top = preferredTop + menuRect.height <= window.innerHeight - 3
    ? preferredTop
    : Math.max(3, anchorRect.top - menuRect.height);

  finishPopupPosition(left, top);
}

function showPopupAt(clientX: number, clientY: number, items: MenuItem[]): void {
  fillPopup(items);
  const menuRect = popupMenu.getBoundingClientRect();
  const left = Math.max(3, Math.min(clientX, window.innerWidth - menuRect.width - 3));
  const top = Math.max(3, Math.min(clientY, window.innerHeight - menuRect.height - 3));
  finishPopupPosition(left, top);
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
  query("#zoom-out").addEventListener("click", () => changePageZoom(-1));
  query("#zoom-reset").addEventListener("click", () => void applyPageZoom(1));
  query("#zoom-in").addEventListener("click", () => changePageZoom(1));
  query("#self-avatar-button").addEventListener("click", openAvatarDialog);
  query("#settings-button").addEventListener("click", (event) => {
    showPopup(event.currentTarget as HTMLElement, [
      { label: "更换头像...", action: openAvatarDialog },
      { separator: true, label: "" },
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
  query("#terminal-rename").addEventListener("click", () => openRenameTerminal());
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
    const rows = [...contactList.querySelectorAll<HTMLButtonElement>(
      ".contact-row, .project-directory-header .group-header, .project-folder-row",
    )];
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
          { separator: true, label: "" },
          { label: `放大页面 (${Math.round(currentZoom * 100)}%)`, action: () => changePageZoom(1), disabled: currentZoom === ZOOM_LEVELS.at(-1) },
          { label: "恢复原始大小 (100%)", action: () => void applyPageZoom(1), disabled: currentZoom === 1 },
          { label: `缩小页面 (${Math.round(currentZoom * 100)}%)`, action: () => changePageZoom(-1), disabled: currentZoom === ZOOM_LEVELS[0] },
        ],
        tools: [
          { label: "更换头像...", action: openAvatarDialog },
          { separator: true, label: "" },
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
  query("#avatar-dialog-close").addEventListener("click", () => closeAvatarDialog());
  query("#avatar-cancel").addEventListener("click", () => closeAvatarDialog());
  query("#avatar-save").addEventListener("click", saveAvatar);
  query("#avatar-choose").addEventListener("click", () => avatarFileInput.click());
  query("#avatar-default").addEventListener("click", () => {
    pendingAvatar = null;
    avatarPreview.src = selfAvatar;
    query("#avatar-file-name").textContent = "默认头像";
    avatarError.textContent = "";
  });
  avatarFileInput.addEventListener("change", () => void selectAvatarFile(avatarFileInput.files?.[0]));
  query("#terminal-rename-close").addEventListener("click", () => closeRenameTerminal());
  query("#terminal-rename-cancel").addEventListener("click", () => closeRenameTerminal());
  query<HTMLFormElement>("#terminal-rename-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void renameTerminal();
  });
  terminalRenameDialog.addEventListener("click", (event) => {
    if (event.target === terminalRenameDialog) closeRenameTerminal();
  });
  query("#project-directory-close").addEventListener("click", () => closeProjectDirectoryDialog());
  query("#project-directory-cancel").addEventListener("click", () => closeProjectDirectoryDialog());
  query<HTMLFormElement>("#project-directory-form").addEventListener("submit", (event) => {
    event.preventDefault();
    saveProjectDirectory();
  });
  projectDirectoryDialog.addEventListener("click", (event) => {
    if (event.target === projectDirectoryDialog) closeProjectDirectoryDialog();
  });
  query("#project-folder-close").addEventListener("click", () => closeProjectFolderDialog());
  query("#project-folder-cancel").addEventListener("click", () => closeProjectFolderDialog());
  query<HTMLFormElement>("#project-folder-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void addProjectFolder();
  });
  projectFolderDialog.addEventListener("click", (event) => {
    if (event.target === projectFolderDialog) closeProjectFolderDialog();
  });
  query("#project-rename-close").addEventListener("click", () => closeProjectRenameDialog());
  query("#project-rename-cancel").addEventListener("click", () => closeProjectRenameDialog());
  query<HTMLFormElement>("#project-rename-form").addEventListener("submit", (event) => {
    event.preventDefault();
    renameProjectFolder();
  });
  projectRenameDialog.addEventListener("click", (event) => {
    if (event.target === projectRenameDialog) closeProjectRenameDialog();
  });
  query("#project-remove-close").addEventListener("click", () => closeProjectRemovalDialog());
  query("#project-remove-cancel").addEventListener("click", () => closeProjectRemovalDialog());
  query("#project-remove-confirm").addEventListener("click", () => void confirmProjectRemoval());
  projectRemoveDialog.addEventListener("click", (event) => {
    if (event.target === projectRemoveDialog) closeProjectRemovalDialog();
  });
  aboutDialog.addEventListener("click", (event) => {
    if (event.target === aboutDialog) closeAbout();
  });
  avatarDialog.addEventListener("click", (event) => {
    if (event.target === avatarDialog) closeAvatarDialog();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!popupMenu.hidden && !popupMenu.contains(event.target as Node)) {
      const trigger = (event.target as Element).closest(".menu-trigger, #settings-button, #presence-trigger, #send-options, .project-row-menu, .project-directory-menu");
      if (!trigger) popupMenu.hidden = true;
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.ctrlKey && !event.altKey) {
      if (event.key === "0") {
        event.preventDefault();
        void applyPageZoom(1);
        return;
      }
      if (event.key === "-" || event.code === "NumpadSubtract") {
        event.preventDefault();
        changePageZoom(-1);
        return;
      }
      if (event.key === "=" || event.key === "+" || event.code === "NumpadAdd") {
        event.preventDefault();
        changePageZoom(1);
        return;
      }
    }
    if (event.key === "Escape") {
      popupMenu.hidden = true;
      if (!terminalRenameDialog.hidden) closeRenameTerminal();
      if (!projectDirectoryDialog.hidden) closeProjectDirectoryDialog();
      if (!projectFolderDialog.hidden) closeProjectFolderDialog();
      if (!projectRenameDialog.hidden) closeProjectRenameDialog();
      if (!projectRemoveDialog.hidden) closeProjectRemovalDialog();
      if (!avatarDialog.hidden) closeAvatarDialog();
      closeAbout();
    }
  });
}

async function start(): Promise<void> {
  refreshIcons();
  bindEvents();
  await applyPageZoom(currentZoom, false);
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
    syncProjectFolderContacts();
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
