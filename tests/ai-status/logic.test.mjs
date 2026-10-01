// AI 状态联动逻辑测试（不依赖浏览器）：
//   1. stripTerminalEscapes —— ANSI/控制字符清洗
//   2. paneAiMarkerState   —— running/approval/done 标记识别与“最后标记优先”
//   3. feedPaneAiActivity  —— 字节流喂入 + 静默(done) + 消隐(idle) 状态机（真实计时器）
//   4. publishWorkspaceAiState —— 多面板聚合优先级 approval > running > done > idle
// 运行：node tests/ai-status/logic.test.mjs   （约 20 秒，含真实计时等待）
import assert from "node:assert/strict";
import vm from "node:vm";
import { compileAiModule, constantFromSource } from "./extract.mjs";

const quietMs = Number(constantFromSource("AI_ACTIVITY_QUIET_MS"));
const lingerMs = Number(constantFromSource("AI_ACTIVITY_DONE_LINGER_MS"));
assert.equal(quietMs, 2600, "AI_ACTIVITY_QUIET_MS 契约值");
assert.equal(lingerMs, 6000, "AI_ACTIVITY_DONE_LINGER_MS 契约值");

const { js } = compileAiModule({ includeDom: false });

// ── 沙箱：提供产品代码期望的最小宿主 ──────────────────────────────
const domCalls = [];
const sandbox = {
  window: { setTimeout, clearTimeout },
  projectAiStates: new Map(),
  applyProjectAiStateToDom: (projectId, state) => domCalls.push({ projectId, state }),
};
vm.createContext(sandbox);
vm.runInContext(js, sandbox, { filename: "ai-status.extracted.js" });

function makePane(folderId = "proj-1") {
  const pane = {
    disposed: false,
    aiDecoder: new TextDecoder(),
    aiTail: "",
    aiState: "idle",
    aiLastOutputAt: 0,
    aiQuietTimer: null,
    aiDoneTimer: null,
    workspace: null,
  };
  pane.workspace = { projectFolder: folderId === null ? null : { id: folderId }, panes: new Map() };
  pane.workspace.panes.set(1, pane);
  return pane;
}
const feed = (pane, text) => sandbox.feedPaneAiActivity(pane, new TextEncoder().encode(text));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failed = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✔ ${name}`);
  } catch (error) {
    failed.push({ name, error });
    console.error(`  ✘ ${name}\n    ${error?.message ?? error}`);
  }
}

console.log("\n[1] stripTerminalEscapes");
await test("去除 CSI 颜色/光标序列，保留正文", () => {
  const out = sandbox.stripTerminalEscapes("\u001b[32m\u001b[1m✔ 完成\u001b[0m\u001b[2K\u001b[1G");
  assert.equal(out, "✔ 完成");
});
await test("去除 OSC 标题与 DCS 序列", () => {
  const out = sandbox.stripTerminalEscapes("\u001b]0;codex — ~/proj\u0007正文\u001bP1$q\u001b\\尾");
  assert.equal(out, "正文尾");
});
await test("去除 BEL/单字符转义等 C0 控制符，保留 \\n \\t", () => {
  const out = sandbox.stripTerminalEscapes("a\u0007b\u0008c\u007fd\te\nf");
  assert.equal(out, "abcd\te\nf");
});

console.log("\n[2] paneAiMarkerState —— CLI 输出识别");
await test("codex / pi 运行中：\"esc to interrupt\" → running", () => {
  assert.equal(sandbox.paneAiMarkerState({ aiTail: "⠧ codex 正在工作 (esc to interrupt)" }), "running");
  assert.equal(sandbox.paneAiMarkerState({ aiTail: "Esc to interrupt · Ctrl+R to review" }), "running");
});
await test("pi working 行：盲文 spinner + Working → running（各帧均命中）", () => {
  for (const frame of ["⠋", "⠹", "⠸", "⠦", "⠏"]) {
    assert.equal(
      sandbox.paneAiMarkerState({ aiTail: `${frame} Working (escape to interrupt)` }),
      "running",
      frame,
    );
  }
  assert.equal(sandbox.paneAiMarkerState({ aiTail: "⠧ Working" }), "running", "无尾缀也应命中");
});
await test("盲文 spinner / “working” 单独出现不误报 running", () => {
  const tails = [
    "⠙ react-dom", // npm 等同款 spinner，后面跟的是包名
    "⠸", // 裸 spinner
    "I'm still working on the fix, give me a moment", // 模型回复正文（小写）
    "Working directory: /home/beluga/proj", // 工具输出（无 spinner 前缀）
    "make: Working in /tmp/build",
  ];
  for (const tail of tails) assert.notEqual(sandbox.paneAiMarkerState({ aiTail: tail }), "running", tail);
});
await test("审批文案 → approval（codex / Claude Code / pi permission 扩展各形态）", () => {
  const tails = [
    "Yes, and auto-approve ↵ · No, and tell codex what to do differently (esc)",
    "Do you want to proceed? (y/n)",
    "Do you want to create file.ts?",
    "esc to approve",
    "Don't ask again for session commands",
    // pi 自定义 permission 扩展（~/.pi/agent/extensions/permissions.ts）的审批对话框文案
    "批准执行？ rm -rf node_modules",
    "批准执行？ git push — origin main",
    "❯ 允许执行   总是允许这条命令   阻止",
    "⚠ 审批原因: 破坏性命令 rm",
  ];
  for (const tail of tails) assert.equal(sandbox.paneAiMarkerState({ aiTail: tail }), "approval", tail);
});
await test("pi 常驻状态栏与 /permissions status 不误报 approval", () => {
  const tails = [
    "🛡️ 审批 1·ask", // setStatus 常驻状态栏，会话全程可见
    "当前审批级别: 1 · ask（除只读命令外，所有命令都需要审批）\n总是允许的命令 3 条", // /permissions status
    "已记住这条命令，之后自动放行（/permissions status 可查看）", // 批准后的 notify
    "已阻止: rm -rf /tmp/x", // 拒绝后的 notify，非等待审批
    "用法: /permissions trust <目录>",
  ];
  for (const tail of tails) assert.notEqual(sandbox.paneAiMarkerState({ aiTail: tail }), "approval", tail);
});
await test("codex 完成：\"tokens used\" → done；pi 收尾：\"turn ended\" → done", () => {
  assert.equal(sandbox.paneAiMarkerState({ aiTail: "codex tokens used: 4,201" }), "done");
  // turn-end-notify 扩展（~/.pi/agent/extensions/turn-end-notify.ts）在每轮结束打的收尾行
  assert.equal(sandbox.paneAiMarkerState({ aiTail: "✓ 回合完成 · tokens used: 12,345" }), "done");
  assert.equal(sandbox.paneAiMarkerState({ aiTail: "turn ended（aborted）tokens used: 3,201" }), "done");
  assert.equal(sandbox.paneAiMarkerState({ aiTail: "turn ended（error）" }), "done");
});
await test("普通 shell 输出不误报（返回 null）", () => {
  const tails = [
    "$ npm run build\n✓ built in 3s",
    "make: *** No rule to make target 'x'. Stop.",
    "git clone https://… && cd repo",
    "error: could not compile `libc`",
    "done in 0.4s", // 单词 done 不是标记
  ];
  for (const tail of tails) assert.equal(sandbox.paneAiMarkerState({ aiTail: tail }), null, tail);
});
await test("同一 tail 内多个标记时，位置最靠后的优先", () => {
  assert.equal(
    sandbox.paneAiMarkerState({ aiTail: "tokens used: 1 … esc to interrupt" }),
    "running",
  );
  assert.equal(
    sandbox.paneAiMarkerState({ aiTail: "esc to interrupt … Do you want to proceed?" }),
    "approval",
  );
  assert.equal(
    sandbox.paneAiMarkerState({ aiTail: "Do you want to proceed? … tokens used: 9" }),
    "done",
  );
});
await test("同一正则带 /g 标志可重复调用（matchAll 不污染 lastIndex）", () => {
  for (let i = 0; i < 3; i += 1) {
    assert.equal(sandbox.paneAiMarkerState({ aiTail: "esc to interrupt" }), "running");
  }
});

console.log("\n[3] feedPaneAiActivity 状态机（真实计时器）");
await test("带 ANSI 的运行输出立即进入 running", () => {
  const pane = makePane();
  feed(pane, "\u001b[?25l\u001b[2K⠋ Working (esc to interrupt)\u001b[?25h");
  assert.equal(pane.aiState, "running");
});
await test("带 ANSI 颜色包裹的盲文 working 行也能触发（strip 不剥盲文）", () => {
  const pane = makePane();
  feed(pane, "\u001b[36m⠸\u001b[0m \u001b[2mWorking\u001b[0m\r\n"); // 无 to interrupt 尾缀
  assert.equal(pane.aiState, "running");
  assert.ok(pane.aiTail.includes("⠸ Working"), `tail 应保留盲文帧，实测: ${pane.aiTail}`);
});
await test("running → 标记被新输出冲出窗口且静默 → done → 6s 后回 idle", async () => {
  const pane = makePane("quiet-flow");
  feed(pane, "thinking… (esc to interrupt)");
  assert.equal(pane.aiState, "running");
  // AI CLI 退出后回到 shell，持续输出把运行标记推出 3072 字符窗口
  feed(pane, "$ ls -la\ntotal 0\n".repeat(400));
  assert.equal(pane.aiTail.includes("interrupt"), false, "标记应已滑出窗口");
  await sleep(quietMs + 600);
  assert.equal(pane.aiState, "done");
  await sleep(lingerMs + 600);
  assert.equal(pane.aiState, "idle");
  const states = domCalls.filter((c) => c.projectId === "quiet-flow").map((c) => c.state);
  assert.deepEqual(states, ["running", "done", "idle"]);
});
await test("运行标记持续存在于 tail 时保持 running（不误判 done）", async () => {
  const pane = makePane();
  feed(pane, "(esc to interrupt)");
  await sleep(quietMs + 600);
  assert.equal(pane.aiState, "running", "标记仍在 tail，静默不应降级");
  feed(pane, "tokens used: 12");
  assert.equal(pane.aiState, "done");
});
await test("标记滑出 3072 字符窗口后，静默即判 done", async () => {
  const pane = makePane();
  feed(pane, "(esc to interrupt)");
  feed(pane, "x".repeat(4000));
  await sleep(quietMs + 600);
  assert.equal(pane.aiState, "done");
});
await test("disposed 面板 / 无项目文件夹时喂入无副作用", () => {
  const disposed = makePane();
  disposed.disposed = true;
  feed(disposed, "esc to interrupt");
  assert.equal(disposed.aiState, "idle");

  const noFolder = makePane(null);
  feed(noFolder, "esc to interrupt");
  assert.equal(noFolder.aiState, "idle");
  assert.equal(noFolder.aiTail, "", "无文件夹时不应累积 tail");
});

console.log("\n[4] 多面板聚合 publishWorkspaceAiState");
await test("approval > running > done > idle 优先级", () => {
  const ws = { projectFolder: { id: "agg" }, panes: new Map() };
  const a = { disposed: false, aiState: "idle", aiDoneTimer: null, workspace: ws };
  const b = { disposed: false, aiState: "idle", aiDoneTimer: null, workspace: ws };
  ws.panes.set(1, a).set(2, b);
  domCalls.length = 0;

  sandbox.setPaneAiState(a, "running");
  sandbox.setPaneAiState(b, "done");
  assert.equal(sandbox.projectAiStates.get("agg"), "running");

  sandbox.setPaneAiState(a, "approval");
  assert.equal(sandbox.projectAiStates.get("agg"), "approval");

  sandbox.setPaneAiState(a, "done");
  assert.equal(sandbox.projectAiStates.get("agg"), "done");

  sandbox.setPaneAiState(a, "idle");
  sandbox.setPaneAiState(b, "idle");
  assert.equal(sandbox.projectAiStates.get("agg"), "idle");

  // 状态不变时不重复发布 DOM 更新
  sandbox.setPaneAiState(a, "running");
  const before = domCalls.length;
  sandbox.setPaneAiState(a, "running");
  assert.equal(domCalls.length, before, "相同状态不应重复触发 DOM 更新");
});

console.log(`\n结果：${passed} 通过，${failed.length} 失败`);
if (failed.length) {
  for (const f of failed) console.error(`FAIL: ${f.name}: ${f.error?.stack ?? f.error}`);
  process.exit(1);
}
process.exit(0); // vm 沙箱里的 setTimeout 句柄会阻止事件循环退出
