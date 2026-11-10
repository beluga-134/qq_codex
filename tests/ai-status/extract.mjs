// 从 src/main.ts 中按标记切出 AI 状态联动的真实实现代码，
// 并用项目自带的 TypeScript 编译器转译为可在 Node vm / 浏览器中执行的 JS。
// 这样测试的永远是产品代码本身，而不是复制粘贴的副本。
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("../../node_modules/typescript/lib/typescript.js");

const sourcePath = fileURLToPath(new URL("../../src/main.ts", import.meta.url));
const source = readFileSync(sourcePath, "utf8");

function slice(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start === -1) throw new Error(`start marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  if (end === -1) throw new Error(`end marker not found: ${endMarker}`);
  return source.slice(start, end);
}

// 检测层：类型、AI_ACTIVITY_* 常量、stripTerminalEscapes、paneAiMarkerState、publishWorkspaceAiState
export const detectionSlice = slice(
  'type TerminalPaneAiState = ',
  'function applyProjectAiStateToDom',
);
// DOM 层：applyProjectAiStateToDom（依赖浏览器 DOM）
export const domSlice = slice(
  'function applyProjectAiStateToDom(',
  'function setPaneAiState(',
);
// 状态机层：setPaneAiState、schedulePaneAiQuietCheck、feedPaneAiActivity
export const stateMachineSlice = slice(
  'function setPaneAiState(',
  'function createTerminalPane',
);

export function compileAiModule({ includeDom = true } = {}) {
  const parts = includeDom
    ? [detectionSlice, domSlice, stateMachineSlice]
    : [detectionSlice, stateMachineSlice];
  const code = parts.join("\n");
  const js = ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  }).outputText;
  return { code, js };
}

// 供断言用：从源码常量中读取（避免硬编码漂移）
export function constantFromSource(name) {
  const re = new RegExp(`const ${name} = ([^;]+);`);
  const m = source.match(re);
  if (!m) throw new Error(`constant not found: ${name}`);
  return m[1].trim();
}

if (process.argv[1] && process.argv[1].endsWith("extract.mjs")) {
  const { js } = compileAiModule();
  console.log(`extracted ${js.length} chars of AI-status module from src/main.ts`);
}
