// 截图像素自检：对 visual.test.mjs 产出的状态行截图采样两个区域——
// 左侧 3px 状态条区与右侧行底色参考区，验证“CSS 计算样式 ↔ 实际渲染像素”一致。
// 行底色参与判定（running 呼吸黄底 / approval 闪烁红底 / done 常亮绿底 / idle 白底），
// 条区观测色应落在 [条色, 实测底色] 的透明度插值线段上；
// done 条常亮 t≈1；idle 两区均为纯白。
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

function coverageOnSegment(observed, barColor, base = [255, 255, 255]) {
  // 求观测色是否可由 barColor 以透明度 t 叠加 base 底色得到（任意 t∈[0,1]）
  let t;
  if (base[0] === barColor[0]) t = 0.5;
  else t = (base[0] - observed[0]) / (base[0] - barColor[0]);
  if (t < 0 || t > 1) return -1;
  const fit = barColor.every((c, i) => Math.abs(observed[i] - (c * t + base[i] * (1 - t))) <= 4);
  return fit ? t : -1;
}

const cases = [
  { file: "static-p-idle.png", mode: "plain", expect: [255, 255, 255] },
  { file: "static-p-running.png", mode: "animated", bar: [224, 173, 38] },
  { file: "static-p-approval.png", mode: "animated", bar: [216, 73, 63] },
  { file: "static-p-done.png", mode: "plain", bar: [40, 176, 74], rowBg: [220, 242, 224] },
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
    const mean = (x0, x1) => {
      const d = ctx.getImageData(x0, Math.floor(canvas.height * 0.3), x1 - x0, Math.floor(canvas.height * 0.4)).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n += 1; }
      return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    };
    return { bar: mean(0, 2), bg: mean(8, 14) }; // 条区 0..2px（条中心，避开抗锯齿边缘），行底参考区 8..14px
  }, b64);

  let pass = false;
  let detail = "";
  if (c.mode === "plain" && c.expect) {
    pass = avg.bar.every((v, i) => Math.abs(v - c.expect[i]) <= 2) && avg.bg.every((v, i) => Math.abs(v - c.expect[i]) <= 2);
    detail = `期望 ${c.expect.join(",")}`;
  } else if (c.mode === "plain" && c.rowBg) {
    // done：条常亮（在 [条色, 实测底色] 线段上 t≈1），行底精确命中
    const t = coverageOnSegment(avg.bar, c.bar, avg.bg);
    pass = t >= 0.9 && avg.bg.every((v, i) => Math.abs(v - c.rowBg[i]) <= 2);
    detail = `条色 ${c.bar.join(",")}，行底期望 ${c.rowBg.join(",")}，实测 t=${t < 0 ? "不在插值线段上" : t.toFixed(2)}`;
  } else {
    const t = coverageOnSegment(avg.bar, c.bar, avg.bg);
    pass = t >= 0.1; // 完全看不见(t≈0)才算失败；条与行底的动画相位均可任意
    detail = `条色 ${c.bar.join(",")}，实测底色 ${avg.bg.join(",")}，条透明度相位 t=${t < 0 ? "不在插值线段上" : t.toFixed(2)}`;
  }
  if (!pass) failed += 1;
  console.log(`  ${pass ? "✔" : "✘"} ${c.file}  左条均色=${avg.bar.join(",")}  行底均色=${avg.bg.join(",")}  ${detail}`);
}
await browser.close();
console.log(failed ? `\n结果：${failed} 项像素校验失败` : "\n结果：像素校验全部通过");
process.exit(failed ? 1 : 0);
