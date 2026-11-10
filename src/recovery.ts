//! 崩溃恢复子系统：新对话注册（pi --session-id 注入）、启动时按 resume.json
//! 自动重开终端并拉起 pi 会话、webview 看门狗心跳钩子。从 main.ts 拆出。

import { backend } from "./backend";
import { showToast } from "./ui";
import { state, isTauriRuntime } from "./state";
import { activeTerminalPane, ensureTerminal, splitActiveTerminal, type TerminalPaneRuntime } from "./terminal";

/// main 侧注入（selectContact 属 UI 编排，避免 recovery → main 循环依赖）。
const recoveryHooks = {
  selectContact: async (_contactId: string): Promise<void> => {},
};

export function setRecoveryHooks(hooks: Partial<typeof recoveryHooks>): void {
  Object.assign(recoveryHooks, hooks);
}

//! webview 看门狗心跳钩子：Rust 侧周期性 eval 调用，同步 invoke 回 pong。
export function installWatchdogPing(): void {
  (window as unknown as { __wdPing?: () => void }).__wdPing = () => {
  void backend.watchdogPong().catch(() => undefined);
  };
}


/** 新对话（pi）：由 qqcodex 生成会话 id/名字启动 pi，崩溃后可精确恢复。 */
export async function startNewPiDialog(): Promise<void> {
  const pane = activeTerminalPane();
  if (!pane) {
    showToast("请先打开一个终端窗格");
    return;
  }
  if (!pane.sessionId) {
    showToast("终端尚未就绪，请稍后再试");
    return;
  }
  const folder = pane.workspace.projectFolder;
  try {
    const info = await backend.resumeDialogOpen(
      pane.workspace.contactId,
      pane.id,
      folder?.path ?? "",
      folder?.wslPath ?? null,
    );
    const command = `pi --session-id ${info.sessionId} --name ${JSON.stringify(info.sessionName)}\n`;
    await backend.writePty(pane.sessionId, new TextEncoder().encode(command));
    showToast(`已启动新对话：${info.sessionName}`);
  } catch (error) {
    showToast(error instanceof Error ? error.message : "启动新对话失败");
  }
}

/** 等待窗格 PTY 会话就绪（崩溃恢复时 shell 需要时间启动）。 */
export async function waitPaneReady(pane: TerminalPaneRuntime, tries = 25): Promise<number | null> {
  for (let i = 0; i < tries; i += 1) {
    if (pane.disposed) return null;
    if (pane.sessionId) return pane.sessionId;
    await new Promise((resolve) => window.setTimeout(resolve, 200));
  }
  return pane.sessionId ?? null;
}

/** 向窗格注入 pi resume 命令（对话上下文由 pi 从 jsonl 复原）。 */
export async function writeResumeCommand(pane: TerminalPaneRuntime, piSessionId: string): Promise<void> {
  const sessionId = pane.sessionId ?? (await waitPaneReady(pane));
  if (!sessionId || pane.disposed) return;
  const command = `pi --session-id ${piSessionId}\n`;
  try {
    await backend.writePty(sessionId, new TextEncoder().encode(command));
  } catch {
    // 写入失败（如 shell 已退出）时静默，由用户手动 resume。
  }
}

/** 崩溃后自动恢复：清场遗留 PTY，按 resume.json 逐项目重开窗格并拉起 pi 会话。 */
export async function maybeRecoverDialogs(): Promise<void> {
  if (!isTauriRuntime()) return;
  let status;
  try {
    status = await backend.resumeStatus();
  } catch {
    return;
  }
  if (!status?.crashed) return;
  if (status.fatalLoop) {
    showToast("上次恢复后短时间内再次崩溃，已暂停自动恢复，请人工检查");
    return;
  }
  const panels = status.panels ?? [];
  if (!panels.length) {
    await backend.resumeMarkRecovered().catch(() => undefined);
    return;
  }
  showToast(`检测到上次异常退出，正在恢复 ${panels.length} 个终端对话…`);
  // 清场：杀光遗留 PTY，防旧 pi 进程与新会话双写同一 jsonl。
  await backend.ptyCloseAll().catch(() => undefined);
  const byContact = new Map<string, typeof panels>();
  for (const panel of panels) {
    const list = byContact.get(panel.contactId) ?? [];
    list.push(panel);
    byContact.set(panel.contactId, list);
  }
  for (const [contactId, contactPanels] of byContact) {
    if (!state.snapshot.contacts.some((contact) => contact.id === contactId)) continue; // 项目已删除
    await recoveryHooks.selectContact(contactId).catch(() => undefined);
    for (let index = 0; index < contactPanels.length; index += 1) {
      let pane: TerminalPaneRuntime | null;
      if (index === 0) {
        pane = ensureTerminal(true, contactId);
      } else {
        await splitActiveTerminal("left-right").catch(() => undefined);
        pane = activeTerminalPane();
      }
      const panel = contactPanels[index];
      if (pane) void writeResumeCommand(pane, panel.sessionId);
    }
  }
  await backend.resumeMarkRecovered().catch(() => undefined);
}

