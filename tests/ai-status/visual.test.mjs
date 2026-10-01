// AI 状态视觉效果测试（Playwright + Chromium，无头）：
//   1. 静态四态：用真实 src/styles.css 和与 main.ts projectFolderRow() 相同的 DOM 结构，
//      断言 ::before 状态条 / 文件夹角标 / 行背景 / 状态文字 的颜色与动画参数
//   2. 动画验证：按帧采样 computed opacity，确认黄脉冲、红闪烁真的在动，绿色常亮不动
//   3. 准端到端：把从 main.ts 提取并编译的真实检测代码注入页面，
//      模拟 codex 的 ANSI 输出流，断言 data-ai-state 依次 running→approval→done→idle
// 运行：node tests/ai-status/visual.test.mjs
//   需要 playwright-core（npm install，见 tests/ai-status/package.json）
//   和 Playwright Chromium（npx playwright install chromium 或任意已缓存版本，自动发现）
import assert from "node:assert/strict";
import { readFileSync, copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { compileAiModule } from "./extract.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const outDir = join(projectRoot, "tests", "ai-status", "out");
mkdirSync(outDir, { recursive: true });
mkdirSync(join(outDir, "assets", "fonts"), { recursive: true });
mkdirSync(join(outDir, "vendor"), { recursive: true });

// 复制字体与 lucide，让测试页与真实应用渲染一致
copyFileSync(
  join(projectRoot, "src", "assets", "fonts", "wqy-zenhei-sharp.woff2"),
  join(outDir, "assets", "fonts", "wqy-zenhei-sharp.woff2"),
);
copyFileSync(
  join(projectRoot, "node_modules", "lucide", "dist", "umd", "lucide.min.js"),
  join(outDir, "vendor", "lucide.min.js"),
);

const css = readFileSync(join(projectRoot, "src", "styles.css"), "utf8");
const { js: aiModuleJs } = compileAiModule();

// 与 main.ts 中 AI_ACTIVITY_STATE_TEXT 一致（由检测代码在页面内提供，这里仅用于静态行初始文案）
const STATE_TEXT = { running: "AI 正在工作…", approval: "等待审批…", done: "已完成" };
const UNC_QQ = String.raw`\\wsl.localhost\Ubuntu\home\beluga\qq_codex`;
const UNC_LIVE = String.raw`\\wsl.localhost\Ubuntu\home\beluga\live-proj`;

function rowHtml(id, state, { selected = false, name = "qq_codex", path = UNC_QQ } = {}) {
  const attr = state === "idle" ? "" : ` data-ai-state="${state}"`;
  const copy = state === "idle" ? path : STATE_TEXT[state];
  return `
  <div class="project-folder-row-wrap project-directory-child" data-project-id="${id}"${attr}>
    <button type="button" class="project-folder-row${selected ? " selected" : ""}" role="option" aria-selected="${selected}" title="${path}">
      <span class="project-folder-icon"><i data-lucide="${selected ? "FolderOpen" : "Folder"}" data-size="22"></i></span>
      <span class="project-folder-copy"><strong>${name}</strong><span>${copy}</span></span>
    </button>
    <button type="button" class="project-row-menu" aria-label="${name}的项目菜单"><i data-lucide="MoreHorizontal" data-size="16"></i></button>
  </div>`;
}

const pageHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>AI 状态视觉测试</title>
<style>${css}</style>
</head>
<body>
<main class="app-shell" id="app-shell">
  <div class="workspace" style="height: 620px">
    <aside class="roster-pane" id="roster-pane">
      <section class="self-profile"></section>
      <div class="search-strip"><i data-lucide="Search" data-size="14"></i><input type="search" placeholder="查找联系人" /></div>
      <div class="roster-tabs" role="tablist">
        <button class="roster-tab active" role="tab">好友</button>
        <button class="roster-tab" role="tab">群组</button>
        <button class="roster-tab" role="tab">最近</button>
      </div>
      <div class="contact-list" id="contact-list" role="listbox">
        <div class="group-header-row">
          <div class="group-header">我的项目</div>
          <button class="group-add-terminal" aria-label="添加项目文件夹"><i data-lucide="FolderPlus" data-size="13"></i></button>
        </div>
        ${rowHtml("p-idle", "idle")}
        ${rowHtml("p-running", "running")}
        ${rowHtml("p-approval", "approval")}
        ${rowHtml("p-approval-sel", "approval", { selected: true, name: "selected-proj" })}
        ${rowHtml("p-done", "done")}
      </div>
      <div class="roster-tools"></div>
    </aside>
    <div class="workspace-splitter"></div>
    <section class="chat-pane" aria-label="聊天窗口"></section>
  </div>
</main>
<script src="vendor/lucide.min.js"></script>
<script>
  lucide.createIcons({ icons: {
    Folder: lucide.Folder, FolderOpen: lucide.FolderOpen, MoreHorizontal: lucide.MoreHorizontal,
    Search: lucide.Search, FolderPlus: lucide.FolderPlus,
  } });
  // 为注入的真实检测代码准备宿主全局（与 main.ts 模块作用域对应）
  window.projectFolders = [{ id: "live", path: ${JSON.stringify(UNC_LIVE)} }];
  window.contactList = document.getElementById("contact-list");
  window.projectAiStates = new Map();
</script>
</body>
</html>`;

// ── Playwright Chromium 发现 ────────────────────────────────────────
function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  const cache = join(homedir(), ".cache", "ms-playwright");
  try {
    const dirs = readdirSync(cache).filter((d) => /^chromium(-headless-shell)?-\d+$/.test(d)).sort();
    for (const dir of dirs.reverse()) {
      for (const sub of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
        try {
          const p = join(cache, dir, sub);
          readFileSync(p); // 探测存在
          return p;
        } catch { /* continue */ }
      }
    }
  } catch { /* no cache */ }
  return null;
}

const executablePath = findChromium();
if (!executablePath) {
  console.error("未找到 Playwright Chromium，请先运行：npx playwright install chromium");
  process.exit(1);
}

const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
page.on("console", (m) => { if (m.type() === "error") console.error("CONSOLE:", m.text()); });

const indexPath = join(outDir, "index.html");
const { writeFileSync } = await import("node:fs");
writeFileSync(indexPath, pageHtml);
await page.goto(`file://${indexPath}`);
await page.waitForTimeout(300); // 等字体/图标

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
const rgb = (r, g, b) => `rgb(${r}, ${g}, ${b})`;
const styleOf = (selector, pseudo, prop) => page.evaluate(
  ([sel, ps, p]) => getComputedStyle(document.querySelector(sel), ps)[p],
  [selector, pseudo, prop],
);

console.log("\n[1] 静态状态样式（真实 styles.css）");
const barSel = (id) => `[data-project-id="${id}"]`;
await test("idle：无状态条、角标隐藏、显示路径", async () => {
  assert.equal(await styleOf(barSel("p-idle"), "::before", "backgroundColor"), "rgba(0, 0, 0, 0)");
  assert.equal(await styleOf(barSel("p-idle") + " .project-folder-icon", "::after", "opacity"), "0");
  assert.equal(await page.textContent("[data-project-id=\"p-idle\"] .project-folder-copy span"), UNC_QQ);
});
await test("running：黄条 #e0ad26 + 脉冲动画 + 黄角标 + 状态文字", async () => {
  assert.equal(await styleOf(barSel("p-running"), "::before", "backgroundColor"), rgb(224, 173, 38));
  assert.equal(await styleOf(barSel("p-running"), "::before", "animationName"), "ai-status-pulse");
  assert.equal(await styleOf(barSel("p-running"), "::before", "animationDuration"), "1.2s");
  assert.equal(await styleOf(barSel("p-running") + " .project-folder-icon", "::after", "backgroundColor"), rgb(224, 173, 38));
  assert.equal(await styleOf(barSel("p-running") + " .project-folder-icon", "::after", "opacity"), "1");
  assert.equal(await page.textContent("[data-project-id=\"p-running\"] .project-folder-copy span"), "AI 正在工作…");
  assert.equal(await styleOf(barSel("p-running") + " .project-folder-copy span", "", "color"), rgb(139, 108, 18));
  assert.equal(await styleOf(barSel("p-running") + " .project-folder-copy span", "", "fontWeight"), "700");
});
await test("approval：红条 #d8493f + 0.6s steps 闪烁 + 红角标 + 行底色 #fdefec", async () => {
  assert.equal(await styleOf(barSel("p-approval"), "::before", "backgroundColor"), rgb(216, 73, 63));
  assert.equal(await styleOf(barSel("p-approval"), "::before", "animationName"), "ai-status-blink");
  assert.equal(await styleOf(barSel("p-approval"), "::before", "animationDuration"), "0.6s");
  assert.equal(await styleOf(barSel("p-approval") + " .project-folder-icon", "::after", "backgroundColor"), rgb(216, 73, 63));
  assert.equal(await styleOf(barSel("p-approval"), "", "backgroundColor"), rgb(253, 239, 236));
  assert.equal(await page.textContent("[data-project-id=\"p-approval\"] .project-folder-copy span"), "等待审批…");
  assert.equal(await styleOf(barSel("p-approval") + " .project-folder-copy span", "", "color"), rgb(163, 34, 24));
});
await test("approval + 选中：保持选中蓝底，不加红色行底色", async () => {
  assert.equal(await styleOf(barSel("p-approval-sel"), "", "backgroundColor"), rgb(255, 255, 255));
  assert.equal(await styleOf(barSel("p-approval-sel") + " .project-folder-row", "", "backgroundColor"), "rgb(49, 106, 197)");
});
await test("done：绿条 #28b04a 常亮无动画 + 绿角标 + 绿色文字", async () => {
  assert.equal(await styleOf(barSel("p-done"), "::before", "backgroundColor"), rgb(40, 176, 74));
  assert.equal(await styleOf(barSel("p-done"), "::before", "animationName"), "none");
  assert.equal(await styleOf(barSel("p-done") + " .project-folder-icon", "::after", "backgroundColor"), rgb(40, 176, 74));
  assert.equal(await page.textContent("[data-project-id=\"p-done\"] .project-folder-copy span"), "已完成");
  assert.equal(await styleOf(barSel("p-done") + " .project-folder-copy span", "", "color"), rgb(23, 107, 53));
});

await page.screenshot({ path: join(outDir, "static-all-states.png") });
for (const id of ["p-idle", "p-running", "p-approval", "p-approval-sel", "p-done"]) {
  const el = page.locator(`[data-project-id="${id}"]`);
  await el.screenshot({ path: join(outDir, `static-${id}.png`) });
}

console.log("\n[2] 动画行为（逐帧采样 ::before opacity）");
async function sampleOpacity(id, durationMs, stepMs = 60) {
  return page.evaluate(async ([sel, duration, step]) => {
    const el = document.querySelector(sel);
    const samples = [];
    const start = performance.now();
    while (performance.now() - start < duration) {
      samples.push(Number(getComputedStyle(el, "::before").opacity));
      await new Promise((r) => setTimeout(r, step));
    }
    return samples;
  }, [barSel(id), durationMs, stepMs]);
}
await test("running 黄条 opacity 在 1 ↔ 0.3 间脉动", async () => {
  const s = await sampleOpacity("p-running", 2600);
  assert.ok(Math.max(...s) >= 0.9, `峰值应≈1，实测 ${Math.max(...s)}`);
  assert.ok(Math.min(...s) <= 0.5, `谷值应≈0.3，实测 ${Math.min(...s)}`);
  assert.ok(Math.max(...s) - Math.min(...s) >= 0.3, "应有明显明暗变化");
});
await test("approval 红条 opacity 以 steps 在 1 ↔ 0.1 间跳变", async () => {
  const s = await sampleOpacity("p-approval", 1800);
  assert.ok(Math.max(...s) >= 0.9, `亮相应≈1，实测 ${Math.max(...s)}`);
  assert.ok(Math.min(...s) <= 0.3, `暗相应≈0.1，实测 ${Math.min(...s)}`);
  // steps(2,end)：值只会在两档之间跳变，不连续过渡
  const distinct = [...new Set(s.map((v) => Math.round(v * 10) / 10))];
  assert.ok(distinct.length <= 3, `steps 动画不应有大量中间值，实测 ${distinct.join(",")}`);
});
await test("done 绿条 opacity 恒为 1（常亮）", async () => {
  const s = await sampleOpacity("p-done", 1200);
  assert.ok(s.every((v) => v === 1), `应恒为 1，实测 ${[...new Set(s)].join(",")}`);
});

console.log("\n[3] 准端到端：注入真实检测代码，模拟 codex ANSI 输出流");
await page.addScriptTag({ content: aiModuleJs });
const feedLive = (text) => page.evaluate((t) => {
  const pane = window.__pane ??= (() => {
    const p = {
      disposed: false,
      aiDecoder: new TextDecoder(),
      aiTail: "",
      aiState: "idle",
      aiLastOutputAt: 0,
      aiQuietTimer: null,
      aiDoneTimer: null,
      workspace: null,
    };
    p.workspace = { projectFolder: { id: "live" }, panes: new Map([[1, p]]) };
    return p;
  })();
  feedPaneAiActivity(pane, new TextEncoder().encode(t));
}, text);
const liveState = () => page.evaluate(() => {
  const wrap = document.querySelector('[data-project-id="live"]');
  return {
    aiState: wrap.dataset.aiState ?? "idle",
    copy: wrap.querySelector(".project-folder-copy span").textContent,
    beforeColor: getComputedStyle(wrap, "::before").backgroundColor,
  };
});

// 动态追加 live 行（模拟 selectProjectFolder 后 roster 重渲染的行）
await page.evaluate(() => {
  const list = document.getElementById("contact-list");
  const wrap = document.createElement("div");
  wrap.className = "project-folder-row-wrap project-directory-child";
  wrap.dataset.projectId = "live";
  wrap.innerHTML = `
    <button type="button" class="project-folder-row" role="option">
      <span class="project-folder-icon"><i data-lucide="Folder" data-size="22"></i></span>
      <span class="project-folder-copy"><strong>live-proj</strong><span></span></span>
    </button>
    <button type="button" class="project-row-menu"><i data-lucide="MoreHorizontal" data-size="16"></i></button>`;
  wrap.querySelector(".project-folder-copy span").textContent = window.projectFolders[0].path;
  list.append(wrap);
  lucide.createIcons({ icons: { Folder: lucide.Folder, MoreHorizontal: lucide.MoreHorizontal } });
});

await test("codex 启动输出 → running（黄条 + 状态文字替换路径）", async () => {
  await feedLive("\u001b[?25l\u001b[2K\u001b[36m⠧\u001b[0m \u001b[1mcodex\u001b[0m 正在分析依赖… (esc to interrupt)\r\n");
  const s = await liveState();
  assert.equal(s.aiState, "running");
  assert.equal(s.copy, "AI 正在工作…");
  assert.equal(s.beforeColor, "rgb(224, 173, 38)");
  await page.locator('[data-project-id="live"]').screenshot({ path: join(outDir, "live-1-running.png") });
});
await test("codex 审批提示 → approval（红条 + 行底色）", async () => {
  await feedLive("\u001b[2K\r\u001b[1mAllow command:\u001b[0m npm install \u001b[2m·\u001b[0m Yes, and auto-approve ↵ · No, tell codex what to do differently (esc)\r\n");
  const s = await liveState();
  assert.equal(s.aiState, "approval");
  assert.equal(s.copy, "等待审批…");
  assert.equal(s.beforeColor, "rgb(216, 73, 63)");
  const bg = await styleOf(barSel("live"), "", "backgroundColor");
  assert.equal(bg, "rgb(253, 239, 236)");
  await page.locator('[data-project-id="live"]').screenshot({ path: join(outDir, "live-2-approval.png") });
});
await test("用户批准后继续 → running", async () => {
  await feedLive("\u001b[2K\r\u001b[32m✔\u001b[0m 已批准 · 继续执行 (esc to interrupt)\r\n");
  assert.equal((await liveState()).aiState, "running");
});
await test("codex 完成 \"tokens used\" → done（绿条）", async () => {
  await feedLive("\u001b[2K\r\u001b[32m✔\u001b[0m 完成 \u001b[2mtokens used: 4,201\u001b[0m\r\n$ ");
  const s = await liveState();
  assert.equal(s.aiState, "done");
  assert.equal(s.copy, "已完成");
  assert.equal(s.beforeColor, "rgb(40, 176, 74)");
  await page.locator('[data-project-id="live"]').screenshot({ path: join(outDir, "live-3-done.png") });
});
await test("6s 后自动回 idle（清除 dataset、恢复路径文字）", async () => {
  await page.waitForTimeout(6600);
  const s = await liveState();
  assert.equal(s.aiState, "idle");
  assert.equal(s.copy, UNC_LIVE);
  assert.equal(s.beforeColor, "rgba(0, 0, 0, 0)");
  await page.locator('[data-project-id="live"]').screenshot({ path: join(outDir, "live-4-idle.png") });
});

console.log("\n[4] 准端到端：pi + 自定义 permission 扩展的审批流");
await page.evaluate(() => {
  const list = document.getElementById("contact-list");
  const wrap = document.createElement("div");
  wrap.className = "project-folder-row-wrap project-directory-child";
  wrap.dataset.projectId = "live-pi";
  wrap.innerHTML = `
    <button type="button" class="project-folder-row" role="option">
      <span class="project-folder-icon"><i data-lucide="Folder" data-size="22"></i></span>
      <span class="project-folder-copy"><strong>pi-proj</strong><span></span></span>
    </button>
    <button type="button" class="project-row-menu"><i data-lucide="MoreHorizontal" data-size="16"></i></button>`;
  wrap.querySelector(".project-folder-copy span").textContent = window.projectFolders[0].path;
  list.append(wrap);
  lucide.createIcons({ icons: { Folder: lucide.Folder, MoreHorizontal: lucide.MoreHorizontal } });
});
const feedPi = (text) => page.evaluate((t) => {
  const pane = window.__panePi ??= (() => {
    const p = {
      disposed: false,
      aiDecoder: new TextDecoder(),
      aiTail: "",
      aiState: "idle",
      aiLastOutputAt: 0,
      aiQuietTimer: null,
      aiDoneTimer: null,
      workspace: null,
    };
    p.workspace = { projectFolder: { id: "live-pi" }, panes: new Map([[1, p]]) };
    return p;
  })();
  feedPaneAiActivity(pane, new TextEncoder().encode(t));
}, text);
const piState = () => page.evaluate(() => {
  const wrap = document.querySelector('[data-project-id="live-pi"]');
  return {
    aiState: wrap.dataset.aiState ?? "idle",
    copy: wrap.querySelector(".project-folder-copy span").textContent,
    barColor: getComputedStyle(wrap, "::before").backgroundColor,
    rowBg: getComputedStyle(wrap).backgroundColor,
  };
});

await test("pi 常驻状态栏（🛡️ 审批级别）单独出现不触发 approval", async () => {
  await feedPi("\u001b[32m●\u001b[0m pi 0.99.2 · \u001b[36m🛡️ 审批 1·ask\u001b[0m\r\n");
  assert.equal((await piState()).aiState, "idle");
});
await test("pi 运行中（escape to interrupt）→ running 黄条", async () => {
  await feedPi("\u001b[2K⠸ Working… \u001b[2m(escape to interrupt)\u001b[0m\r\n");
  const s = await piState();
  assert.equal(s.aiState, "running");
  assert.equal(s.copy, "AI 正在工作…");
  await page.locator('[data-project-id="live-pi"]').screenshot({ path: join(outDir, "pi-1-running.png") });
});
await test("permission 扩展弹审批（批准执行？/审批原因:）→ approval 红条 + 行底色", async () => {
  await feedPi(
    "\u001b[33m⚠ 审批原因: 破坏性命令 rm\u001b[0m\r\n" +
    "╭──────────────────────────────╮\r\n" +
    "│ \u001b[1m\u001b[36m批准执行？ rm -rf node_modules\u001b[0m │\r\n" +
    "│ ❯ 允许执行   总是允许这条命令   阻止 │\r\n" +
    "╰──────────────────────────────╯\r\n",
  );
  const s = await piState();
  assert.equal(s.aiState, "approval");
  assert.equal(s.copy, "等待审批…");
  assert.equal(s.barColor, "rgb(216, 73, 63)");
  assert.equal(s.rowBg, "rgb(253, 239, 236)");
  await page.locator('[data-project-id="live-pi"]').screenshot({ path: join(outDir, "pi-2-approval.png") });
});
await test("选择“允许执行”后恢复 running；/permissions status 仍不误报", async () => {
  await feedPi("\u001b[2K✔ 已批准，继续 (escape to interrupt)\u001b[0m\r\n");
  assert.equal((await piState()).aiState, "running");
  await feedPi("当前审批级别: 1 · ask（除只读命令外）\r\n总是允许的命令 0 条\r\n");
  assert.equal((await piState()).aiState, "running", "status 输出不应改变状态");
  await page.locator('[data-project-id="live-pi"]').screenshot({ path: join(outDir, "pi-3-resumed.png") });
});

await browser.close();
console.log(`\n结果：${passed} 通过，${failed.length} 失败；截图见 tests/ai-status/out/`);
if (failed.length) {
  for (const f of failed) console.error(`FAIL: ${f.name}: ${f.error?.message ?? f.error}`);
  process.exit(1);
}
process.exit(0);
