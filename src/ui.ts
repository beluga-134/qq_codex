//! UI 基础件：图标表/渲染、DOM 查询、toast。从 main.ts 拆出。

import { createIcons,
ArrowLeft,
  Bell,
  Bold,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  Clock3,
  Columns2,
  FilePen,
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
  MessageSquarePlus,
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
  ZoomOut } from "lucide";

const iconSet = {
  ArrowLeft,
  Bell,
  Bold,
  MessageSquarePlus,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  Clock3,
  Columns2,
  Eraser,
  FilePen,
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


export function icon(name: keyof typeof iconSet, size = 16): string {
  return `<i data-lucide="${name}" data-size="${size}" aria-hidden="true"></i>`;
}

export function refreshIcons(): void {
  createIcons({ icons: iconSet });
}

export function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}

// toast DOM 由 main.ts 模板动态渲染，模块加载期不存在，必须惰性获取。
function toastEl(): HTMLDivElement {
  return query<HTMLDivElement>("#toast");
}

let toastTimer: number | null = null;

export function showToast(text: string, placement: "bottom-right" | "top-right" = "bottom-right"): void {
  const toast = toastEl();
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
