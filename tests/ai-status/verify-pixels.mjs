// 截图像素自检：对 visual.test.mjs 产出的状态行截图采样左侧 3px 状态条，
// 验证“CSS 计算样式 ↔ 实际渲染像素”一致。
// running/approval 条带动画，允许观测色落在 [条色, 白底] 的透明度插值线段上；
// done 常亮必须精确命中；idle 必须是纯白（无条）。
// 运行：node tests/ai-status/verify-pixels.mjs   （依赖 playwright-core）
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");

const outDir = fileURLToPath(new URL("./out", import.meta.url));

// 发现 Chromium（与 visual.test.mjs 相同逻辑）
function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  const { homedir, readdirSync } = require("node:os") && {
    homedir: require("node:os").homedir,
    readdirSync: require("node:fs").readdirSync,
  };
  const cache = join(homedir(), ".cache", "ms-playwright");
  try {
    const dirs = readdirSync(cache).filter((d) => /^chromium(-headless-shell)?-\d+$/.test(d)).sort().reverse();
    for (const dir of dirs) {
      for (const sub of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
        try { return join(cache, dir, sub); } catch { /* probe below */ }
      }
    }
  } catch { /* no cache */ }
  return null;
}

function coverageOnSegment(observed, barColor, white = [255, 255, 255]) {
  // 求观测色是否可由 barColor 以透明度 t 叠加白底得到（任意 t∈[0,1]）
  let t;
  if (white[0] === barColor[0]) t = 0.5;
  else t = (white[0] - observed[0]) / (white[0] - barColor[0]);
  if (t < 0 || t > 1) return -1;
  const fit = barColor.every((c, i) => Math.abs(observed[i] - (c * t + white[i] * (1 - t))) <= 3);
  return fit ? t : -1;
}

const cases = [
  { file: "static-p-idle.png", mode: "plain", expect: [255, 255, 255] },
  { file: "static-p-running.png", mode: "animated", bar: [224, 173, 38] },
  { file: "static-p-approval.png", mode: "animated", bar: [216, 73, 63] },
  { file: "static-p-done.png", mode: "plain", expect: [40, 176, 74] },
];

const executablePath = findChromium();
if (!executablePath) {
  console.error("未找到 Playwright Chromium，请先运行：npx playwright install chromium");
  process.exit(1);
}
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage();
await page.goto("about:blank");

let failed = 0;
for (const c of cases) {
  const b64 = readFileSync(join(outDir, c.file)).toString("base64");
  const avg = await page.evaluate(async (data) => {
    const img = new Image();
    img.src = "data:image/png;base64," + data;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width; canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, Math.floor(canvas.height * 0.3), 6, Math.floor(canvas.height * 0.4)).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n += 1; }
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  }, b64);

  let pass = false;
  let detail = "";
  if (c.mode === "plain") {
    pass = avg.every((v, i) => Math.abs(v - c.expect[i]) <= 2);
    detail = `期望 ${c.expect.join(",")}`;
  } else {
    const t = coverageOnSegment(avg, c.bar);
    pass = t >= 0.12; // 完全看不见(t≈0)才算失败；动画相位可任意
    detail = `条色 ${c.bar.join(",")}，实测透明度相位 t=${t < 0 ? "不在插值线段上" : t.toFixed(2)}`;
  }
  if (!pass) failed += 1;
  console.log(`  ${pass ? "✔" : "✘"} ${c.file}  左条均色=${avg.join(",")}  ${detail}`);
}
await browser.close();
console.log(failed ? `\n结果：${failed} 项像素校验失败` : "\n结果：像素校验全部通过");
process.exit(failed ? 1 : 0);
