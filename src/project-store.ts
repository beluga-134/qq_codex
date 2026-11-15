//! 项目存储域（从 main.ts 拆出，2026-11-14）：localStorage 兜底 + 便携文件
//! 持久化的数据与纯逻辑——校验/解析/序列化/去抖落盘。UI 编排（init/文件
//! 变更处理/联系人同步）仍留 main.ts，经本模块导出的函数与活绑定访问数据。

import { backend } from "./backend";
import type { ProjectDirectory, ProjectFolder, ProjectFolderLocation } from "./types";
import { isTauriRuntime } from "./state";
import { showToast } from "./ui";

const PROJECT_FOLDERS_STORAGE_KEY = "ociq.project-folders.v1";
const PROJECT_DIRECTORIES_STORAGE_KEY = "ociq.project-directories.v1";
const DEFAULT_PROJECT_DIRECTORY_ID = "default-project-directory";

/** 项目存储文件变更事件（Rust 侧 emit）。 */
export const PROJECT_STORE_CHANGED_EVENT = "project-store-changed";

export let projectDirectories = readStoredProjectDirectories();
export let projectFolders = readStoredProjectFolders();

let projectStorePersistTimer: number | null = null;
let projectStoreFlushInFlight = false;

export function isStoredProjectPath(path: string): boolean {
  if (!path || [...path].length > 1024 || /[\u0000-\u001f\u007f]/.test(path)) return false;
  return /^[A-Za-z]:\\/.test(path)
    || /^\\\\[^\\]+\\[^\\]+/.test(path)
    || path.startsWith("/");
}

export function isStoredWslPath(value: unknown): value is string {
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

export function isStoredWslDistribution(value: unknown): value is string | null {
  if (value === null) return true;
  return typeof value === "string"
    && value === value.trim()
    && value.length > 0
    && [...value].length <= 128
    && !/[\\/\u0000-\u001f\u007f<>:"|?*]/.test(value)
    && !/[. ]$/.test(value);
}

export function hasProjectLaunchCache(folder: ProjectFolder): folder is ProjectFolder & { wslPath: string } {
  return isStoredWslPath(folder.wslPath)
    && folder.wslDistribution !== undefined
    && isStoredWslDistribution(folder.wslDistribution);
}

export function projectLaunchCache(
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

export function parsedProjectLaunchCache(
  location: ProjectFolderLocation,
): { wslPath: string; wslDistribution: string | null } | null {
  return /^[A-Za-z]:\\/.test(location.path) ? null : projectLaunchCache(location);
}

export function projectPathKey(path: string): string {
  const wslUnc = /^\\\\(wsl\.localhost|wsl\$)\\([^\\]+)(.*)$/i.exec(path);
  if (wslUnc) {
    return `wsl-unc:${wslUnc[2]!.toLowerCase()}${wslUnc[3] ?? ""}`;
  }
  if (path.startsWith("/")) return `wsl:${path}`;
  return `windows:${path.toLowerCase()}`;
}

export function defaultProjectDirectory(): ProjectDirectory {
  return { id: DEFAULT_PROJECT_DIRECTORY_ID, name: "项目文件夹" };
}

export function normalizeProjectDirectoryName(input: string): string {
  const name = input.trim();
  if (!name) throw new Error("目录名称不能为空");
  if ([...name].length > 64) throw new Error("目录名称不能超过 64 个字符");
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error("目录名称包含不支持的控制字符");
  return name;
}

function readStoredProjectDirectories(): ProjectDirectory[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PROJECT_DIRECTORIES_STORAGE_KEY) ?? "[]");
    return parseProjectDirectoriesValue(parsed);
  } catch {
    return [defaultProjectDirectory()];
  }
}

export function parseProjectDirectoriesValue(value: unknown): ProjectDirectory[] {
  if (!Array.isArray(value)) return [defaultProjectDirectory()];
  const ids = new Set<string>();
  const directories = value.filter((item): item is ProjectDirectory => {
    if (!item || typeof item !== "object") return false;
    const candidate = item as Partial<ProjectDirectory>;
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
}

export function saveProjectDirectories(next: ProjectDirectory[]): void {
  projectDirectories = next;
  scheduleProjectStorePersist();
}

function readStoredProjectFolders(): ProjectFolder[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PROJECT_FOLDERS_STORAGE_KEY) ?? "[]");
    return parseProjectFoldersValue(parsed, projectDirectories);
  } catch {
    return [];
  }
}

export function parseProjectFoldersValue(value: unknown, directories: ProjectDirectory[]): ProjectFolder[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  const paths = new Set<string>();
  return value.filter((item): item is ProjectFolder => {
    if (!item || typeof item !== "object") return false;
    const candidate = item as Partial<ProjectFolder>;
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
      && directories.some((directory) => directory.id === candidate.directoryId)
      ? candidate.directoryId
      : directories[0]!.id;
    if (!isStoredProjectPath(candidate.path)) return false;
    if (typeof candidate.wslPath === "string" && candidate.wslDistribution === undefined) {
      candidate.wslDistribution = null;
    }
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
}

export function saveProjectFolders(next: ProjectFolder[]): void {
  projectFolders = next;
  scheduleProjectStorePersist();
}

/** 文件驱动的整体替换（不触发回写去抖——内容来自文件本身）。 */
export function setProjectStore(directories: ProjectDirectory[], folders: ProjectFolder[]): void {
  projectDirectories = directories;
  projectFolders = folders;
}

/** 持久化忙碌中（有 pending 去抖或写文件在途），外部同步应暂缓。 */
export function projectStoreBusy(): boolean {
  return projectStorePersistTimer !== null || projectStoreFlushInFlight;
}

export function serializeProjectStoreData(
  directories: ProjectDirectory[],
  folders: ProjectFolder[],
): string {
  return JSON.stringify({
    directories: directories.map((directory) => ({ id: directory.id, name: directory.name })),
    folders: folders.map((folder) => ({
      id: folder.id,
      directoryId: folder.directoryId,
      name: folder.name,
      path: folder.path,
      ...(hasProjectLaunchCache(folder)
        ? { wslPath: folder.wslPath, wslDistribution: folder.wslDistribution }
        : {}),
    })),
  });
}

function persistProjectStoreToLocalStorage(): void {
  localStorage.setItem(PROJECT_DIRECTORIES_STORAGE_KEY, JSON.stringify(projectDirectories));
  localStorage.setItem(PROJECT_FOLDERS_STORAGE_KEY, JSON.stringify(projectFolders));
}

function scheduleProjectStorePersist(): void {
  if (!isTauriRuntime()) {
    persistProjectStoreToLocalStorage();
    return;
  }
  if (projectStorePersistTimer !== null) return;
  projectStorePersistTimer = window.setTimeout(() => {
    projectStorePersistTimer = null;
    void flushProjectStore();
  }, 150);
}

export async function flushProjectStore(): Promise<void> {
  if (!isTauriRuntime()) return;
  projectStoreFlushInFlight = true;
  try {
    await backend.writeProjectStore({
      directories: projectDirectories,
      folders: projectFolders,
    });
  } catch (error) {
    showToast(error instanceof Error ? error.message : "无法写入项目数据文件");
  } finally {
    projectStoreFlushInFlight = false;
  }
}

/** 便携文件接管后清掉本机遗留的 localStorage 数据（init 与外部变更同步时调用）。 */
export function clearStoredProjectKeys(): void {
  localStorage.removeItem(PROJECT_DIRECTORIES_STORAGE_KEY);
  localStorage.removeItem(PROJECT_FOLDERS_STORAGE_KEY);
}

export function createProjectFolderId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
