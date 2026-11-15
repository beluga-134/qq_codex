//! 便签面板（从 main.ts 拆出，2026-11-14）：桌面版存 exe 同目录 notes.json
//! （便携），浏览器预览降级 localStorage。折叠/宽度偏好本地持久化。

import { backend } from "./backend";
import { state, isTauriRuntime } from "./state";
import { query, showToast } from "./ui";
import { scheduleTerminalFit } from "./terminal";

// 桌面版便签存 exe 同目录 notes.json（便携）；浏览器预览降级 localStorage。
const NOTES_STORAGE_KEY = "ociq.ui.notes";
const NOTES_COLLAPSED_STORAGE_KEY = "ociq.ui.notes-collapsed";
const NOTES_WIDTH_STORAGE_KEY = "ociq.ui.notes-width";
const NOTES_WIDTH_MIN = 180;
const NOTES_WIDTH_MAX = 480;
let notesContactId: string | null = null;
let notesSaveTimer: number | null = null;
let notesMap: Record<string, string> | null = null; // null = 尚未从后端加载

function notesKey(contactId: string | null): string {
  return contactId ?? "_default";
}

/** 桌面版：从 exe 同目录 notes.json 载入（失败静默降级 localStorage 已有内容） */
async function loadNotesMap(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    notesMap = await backend.readNotes();
  } catch {
    notesMap = {};
  }
}

function readNotesEntry(key: string): string {
  if (notesMap !== null) return notesMap[key] ?? "";
  try {
    return localStorage.getItem(`${NOTES_STORAGE_KEY}.${key}`) ?? "";
  } catch {
    return "";
  }
}

function writeNotesEntry(key: string, value: string): void {
  if (notesMap !== null) {
    notesMap[key] = value;
  } else {
    try {
      localStorage.setItem(`${NOTES_STORAGE_KEY}.${key}`, value);
    } catch {
      // 存储不可用时静默，下次输入重试
    }
  }
}

function readStoredNotesCollapsed(): boolean {
  try {
    return localStorage.getItem(NOTES_COLLAPSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function applyNotesCollapsed(collapsed: boolean, announce = false): void {
  query<HTMLElement>(".workspace").classList.toggle("notes-collapsed", collapsed);
  try {
    localStorage.setItem(NOTES_COLLAPSED_STORAGE_KEY, collapsed ? "1" : "0");
  } catch {
    if (announce) showToast("无法保存便签折叠状态");
  }
  requestAnimationFrame(() => scheduleTerminalFit());
  if (announce) showToast(collapsed ? "便签已收起" : "便签已展开");
  if (!collapsed) query<HTMLTextAreaElement>("#notes-input").focus();
}

function updateNotesCount(): void {
  const input = query<HTMLTextAreaElement>("#notes-input");
  query("#notes-count").textContent = `${input.value.length} 字`;
}

async function persistNotesMap(): Promise<void> {
  if (notesMap === null || !isTauriRuntime()) return;
  try {
    await backend.writeNotes(notesMap);
  } catch {
    // 写盘失败保持内存态，下次保存重试
  }
}

function flushNotesSave(): void {
  if (notesSaveTimer === null) return;
  window.clearTimeout(notesSaveTimer);
  notesSaveTimer = null;
  writeNotesEntry(notesKey(notesContactId), query<HTMLTextAreaElement>("#notes-input").value);
  void persistNotesMap();
}

function scheduleNotesSave(): void {
  if (notesSaveTimer !== null) window.clearTimeout(notesSaveTimer);
  notesSaveTimer = window.setTimeout(() => {
    notesSaveTimer = null;
    writeNotesEntry(notesKey(notesContactId), query<HTMLTextAreaElement>("#notes-input").value);
    void persistNotesMap();
  }, 400);
}

/** 切换联系人：先把旧内容落盘，再载入该联系人自己的便签 */
export function loadNotesForContact(contactId: string): void {
  if (notesContactId === contactId) return;
  flushNotesSave();
  notesContactId = contactId;
  query<HTMLTextAreaElement>("#notes-input").value = readNotesEntry(notesKey(contactId));
  updateNotesCount();
}

function applyNotesWidth(width: number): void {
  const clamped = Math.min(NOTES_WIDTH_MAX, Math.max(NOTES_WIDTH_MIN, Math.round(width)));
  query<HTMLElement>(".workspace").style.setProperty("--notes-width", `${clamped}px`);
}

function initNotesSplitterDrag(): void {
  const splitter = query<HTMLElement>(".notes-splitter");
  splitter.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    splitter.classList.add("is-dragging");
    splitter.setPointerCapture(event.pointerId);
    const workspaceRect = query<HTMLElement>(".workspace").getBoundingClientRect();
    const move = (moveEvent: PointerEvent) => {
      applyNotesWidth(workspaceRect.right - moveEvent.clientX);
    };
    const finish = () => {
      splitter.classList.remove("is-dragging");
      splitter.removeEventListener("pointermove", move);
      splitter.removeEventListener("pointerup", finish);
      splitter.removeEventListener("pointercancel", finish);
      try {
        localStorage.setItem(
          NOTES_WIDTH_STORAGE_KEY,
          query<HTMLElement>(".workspace").style.getPropertyValue("--notes-width") || "236px",
        );
      } catch {
        // 无法持久化时仅本次生效
      }
      scheduleTerminalFit();
    };
    splitter.addEventListener("pointermove", move);
    splitter.addEventListener("pointerup", finish);
    splitter.addEventListener("pointercancel", finish);
  });
}

export async function initNotesPane(): Promise<void> {
  await loadNotesMap();
  const input = query<HTMLTextAreaElement>("#notes-input");
  updateNotesCount();
  input.addEventListener("input", () => {
    updateNotesCount();
    scheduleNotesSave();
  });
  query<HTMLButtonElement>("#notes-collapse").addEventListener("click", () => {
    applyNotesCollapsed(true, true);
  });
  query<HTMLButtonElement>("#notes-expand").addEventListener("click", () => {
    applyNotesCollapsed(false, true);
  });
  initNotesSplitterDrag();
  try {
    const storedWidth = Number.parseInt(localStorage.getItem(NOTES_WIDTH_STORAGE_KEY) ?? "", 10);
    if (Number.isFinite(storedWidth) && storedWidth >= NOTES_WIDTH_MIN) applyNotesWidth(storedWidth);
  } catch {
    // 无保存宽度时用 CSS 默认 236px
  }
  applyNotesCollapsed(readStoredNotesCollapsed());
  notesContactId = null; // 强制下面这次载入生效（renderChatHeader 可能已用空 map 跑过）
  loadNotesForContact(state.snapshot.activeContactId);
}
