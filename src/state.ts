//! 跨模块可变状态收口：当前 AppSnapshot 与联系人判定。
//! 现状与原 main.ts 相同：snapshot 在 start() 完成前事实上为 undefined，
//! 类型上沿用“必有”断言，调用方保持原判空习惯。

import { PROJECT_CONTACT_PREFIX, TERMINAL_CONTACT_ID, type AppSnapshot } from "./types";

export const state = {
  snapshot: undefined as unknown as AppSnapshot,
};

export function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export function projectContactId(projectId: string): string {
  return `${PROJECT_CONTACT_PREFIX}${projectId}`;
}

export function projectIdFromContactId(contactId: string | undefined): string | null {
  return contactId?.startsWith(PROJECT_CONTACT_PREFIX)
    ? contactId.slice(PROJECT_CONTACT_PREFIX.length)
    : null;
}

export function isProjectContact(contactId = state.snapshot?.activeContactId): boolean {
  return projectIdFromContactId(contactId) !== null;
}

export function isTerminalContact(contactId = state.snapshot?.activeContactId): boolean {
  return isProjectContact(contactId)
    || contactId === TERMINAL_CONTACT_ID
    || /^terminal-\d+$/.test(contactId ?? "");
}
