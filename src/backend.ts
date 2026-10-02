import { Channel, invoke } from "@tauri-apps/api/core";

import {
  TERMINAL_CONTACT_ID,
  type AppSnapshot,
  type Contact,
  type Message,
  type Presence,
  type ProjectDirectory,
  type ProjectFolder,
  type ProjectFolderLocation,
  type TerminalExecution,
} from "./types";

export interface PtyExit {
  sessionId: number;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
}

export interface PtyOpenResult {
  sessionId: number;
  project: ProjectFolderLocation | null;
}

export type PtyData = ArrayBuffer | Uint8Array | number[];

export interface ProjectStore {
  directories: ProjectDirectory[];
  folders: ProjectFolder[];
}

const now = Date.now();

const mockUser: Contact = {
  id: "me",
  displayName: "小鲸",
  account: "10001",
  avatarSeed: "self",
  presence: "online",
  statusMessage: "今天也要保持联络",
  group: "self",
  unreadCount: 0,
  lastMessage: "",
  lastMessageAt: now,
};

const mockContacts: Contact[] = [
  {
    id: "ache",
    displayName: "阿澈",
    account: "10240",
    avatarSeed: "ache",
    presence: "online",
    statusMessage: "晚风吹过旧操场",
    group: "我的好友",
    unreadCount: 0,
    lastMessage: "那就今晚八点，老地方见。",
    lastMessageAt: now - 3 * 60_000,
  },
  {
    id: "linxia",
    displayName: "林夏",
    account: "10618",
    avatarSeed: "linxia",
    presence: "away",
    statusMessage: "正在离开电脑",
    group: "我的好友",
    unreadCount: 2,
    lastMessage: "文件收到了吗？",
    lastMessageAt: now - 18 * 60_000,
  },
  {
    id: "mayu",
    displayName: "马宇",
    account: "20331",
    avatarSeed: "mayu",
    presence: "online",
    statusMessage: "山那边信号不错",
    group: "同学",
    unreadCount: 0,
    lastMessage: "周末去爬山？",
    lastMessageAt: now - 42 * 60_000,
  },
  {
    id: "service",
    displayName: "OICQ 服务台",
    account: "10000",
    avatarSeed: "service",
    presence: "online",
    statusMessage: "消息服务器运行正常",
    group: "系统联系人",
    unreadCount: 0,
    lastMessage: "欢迎回来，小鲸。",
    lastMessageAt: now - 90 * 60_000,
  },
  {
    id: TERMINAL_CONTACT_ID,
    displayName: "WSL 终端",
    account: "WSL SHELL",
    avatarSeed: "terminal",
    presence: "online",
    statusMessage: "WSL2 默认发行版 · Linux shell",
    group: "工具",
    unreadCount: 0,
    lastMessage: "输入 help 查看可用命令。",
    lastMessageAt: now - 2 * 60_000,
  },
  {
    id: "oldfriend",
    displayName: "旧友 1999",
    account: "66888",
    avatarSeed: "oldfriend",
    presence: "offline",
    statusMessage: "最后上线：昨天 23:41",
    group: "同学",
    unreadCount: 0,
    lastMessage: "改天再聊。",
    lastMessageAt: now - 24 * 60 * 60_000,
  },
];

const mockMessages = new Map<string, Message[]>([
  [
    "ache",
    [
      {
        id: 1,
        contactId: "ache",
        senderId: "ache",
        senderName: "阿澈",
        text: "在吗？今晚还去老地方吗？",
        sentAt: now - 12 * 60_000,
        outgoing: false,
        read: true,
      },
      {
        id: 2,
        contactId: "ache",
        senderId: "me",
        senderName: "小鲸",
        text: "在。刚把 OICQ 装回来了，还是这个界面顺眼。",
        sentAt: now - 9 * 60_000,
        outgoing: true,
        read: true,
      },
      {
        id: 3,
        contactId: "ache",
        senderId: "ache",
        senderName: "阿澈",
        text: "那就今晚八点，老地方见。",
        sentAt: now - 3 * 60_000,
        outgoing: false,
        read: true,
      },
    ],
  ],
  [
    "linxia",
    [
      {
        id: 4,
        contactId: "linxia",
        senderId: "linxia",
        senderName: "林夏",
        text: "我把照片压缩好了。",
        sentAt: now - 21 * 60_000,
        outgoing: false,
        read: false,
      },
      {
        id: 5,
        contactId: "linxia",
        senderId: "linxia",
        senderName: "林夏",
        text: "文件收到了吗？",
        sentAt: now - 18 * 60_000,
        outgoing: false,
        read: false,
      },
    ],
  ],
  ["mayu", []],
  [
    "service",
    [
      {
        id: 6,
        contactId: "service",
        senderId: "service",
        senderName: "OICQ 服务台",
        text: "欢迎回来，小鲸。当前消息服务器运行正常。",
        sentAt: now - 90 * 60_000,
        outgoing: false,
        read: true,
      },
    ],
  ],
  [
    TERMINAL_CONTACT_ID,
    [
      {
        id: 7,
        contactId: TERMINAL_CONTACT_ID,
        senderId: TERMINAL_CONTACT_ID,
        senderName: "WSL 终端",
        text: "Retro WSL Terminal 1.0\n输入 help 查看可用 Linux 命令。",
        sentAt: now - 2 * 60_000,
        outgoing: false,
        read: true,
      },
    ],
  ],
  ["oldfriend", []],
]);

let mockMessageId = 20;
let mockActiveContact = "ache";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

function isTerminalContactId(contactId: string): boolean {
  return contactId === TERMINAL_CONTACT_ID || /^terminal-\d+$/.test(contactId);
}

function normalizeTerminalName(displayName: string): string {
  const normalized = displayName.trim();
  if (!normalized) throw new Error("终端名称不能为空");
  if ([...normalized].length > 24) throw new Error("终端名称不能超过 24 个字符");
  if ([...normalized].some((character) => /[\u0000-\u001f\u007f]/.test(character))) {
    throw new Error("终端名称包含不支持的控制字符");
  }
  return normalized;
}

interface PreviewResolvedProjectFolder {
  location: ProjectFolderLocation;
}

function isValidWindowsComponent(component: string): boolean {
  return Boolean(component)
    && component !== "."
    && component !== ".."
    && !/[\u0000-\u001f\u007f<>:"|?*]/.test(component)
    && !/[. ]$/.test(component);
}

function normalizeProjectPathComponents(input: string, windowsRules: boolean): string[] {
  const components: string[] = [];
  input.split(/[\\/]+/).forEach((component) => {
    if (!component || component === ".") return;
    if (component === "..") {
      if (!components.pop()) throw new Error("项目路径不能越过根目录");
      return;
    }
    if (/[\u0000-\u001f\u007f]/.test(component)) {
      throw new Error("项目路径包含不支持的控制字符");
    }
    if (windowsRules && !isValidWindowsComponent(component)) {
      throw new Error("项目路径包含 Windows 不支持的字符");
    }
    components.push(component);
  });
  return components;
}

function resolvePreviewProjectPath(input: string): PreviewResolvedProjectFolder {
  const value = input.trim();
  if (!value) throw new Error("请输入项目文件夹路径");
  if ([...value].length > 1024) throw new Error("项目路径不能超过 1024 个字符");
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("项目路径包含不支持的控制字符");
  }

  const driveMatch = /^([a-z]):[\\/](.*)$/i.exec(value);
  if (driveMatch) {
    const drive = driveMatch[1]!.toUpperCase();
    const components = normalizeProjectPathComponents(driveMatch[2] ?? "", true);
    const path = components.length > 0 ? `${drive}:\\${components.join("\\")}` : `${drive}:\\`;
    return {
      location: {
        name: components.at(-1) ?? `${drive} 盘`,
        path,
        wslPath: components.length > 0
          ? `/mnt/${drive.toLowerCase()}/${components.join("/")}`
          : `/mnt/${drive.toLowerCase()}`,
        wslDistribution: null,
      },
    };
  }
  if (/^[^\\/]:/.test(value)) {
    throw new Error("Windows 项目路径必须是盘符绝对路径，例如 C:\\workspace\\project");
  }

  if (value === "~" || /^~[\\/]/.test(value)) {
    const relativeComponents = normalizeProjectPathComponents(value.slice(1), false);
    const components = ["home", "wsl-user", ...relativeComponents];
    const path = `/${components.join("/")}`;
    return {
      location: {
        name: relativeComponents.at(-1) ?? "wsl-user",
        path,
        wslPath: path,
        wslDistribution: null,
      },
    };
  }
  if (value.startsWith("~")) {
    throw new Error("WSL 用户主目录路径仅支持 ~ 或 ~/...");
  }

  if (/^(?:\\\\|\/\/)/.test(value)) {
    const components = value.replace(/^[\\/]+/, "").split(/[\\/]+/).filter(Boolean);
    if (components.length < 2) throw new Error("UNC 项目路径必须包含服务器和共享名称");
    const [rawServer, share, ...rest] = components as [string, string, ...string[]];
    const isWslUnc = /^(?:wsl\.localhost|wsl\$)$/i.test(rawServer);
    if (isWslUnc) {
      if (!isValidWindowsComponent(share)) throw new Error("WSL 发行版名称无效");
      const linuxComponents = normalizeProjectPathComponents(rest.join("/"), false);
      const server = rawServer.toLowerCase() === "wsl.localhost" ? "wsl.localhost" : "wsl$";
      const path = `\\\\${server}\\${share}${linuxComponents.length ? `\\${linuxComponents.join("\\")}` : ""}`;
      return {
        location: {
          name: linuxComponents.at(-1) ?? share,
          path,
          wslPath: linuxComponents.length ? `/${linuxComponents.join("/")}` : "/",
          wslDistribution: share,
        },
      };
    }

    if (!isValidWindowsComponent(rawServer) || !isValidWindowsComponent(share)) {
      throw new Error("UNC 项目路径的服务器或共享名称无效");
    }
    const pathComponents = normalizeProjectPathComponents(rest.join("/"), true);
    const path = `\\\\${rawServer}\\${share}${pathComponents.length ? `\\${pathComponents.join("\\")}` : ""}`;
    const wslPath = `/mnt/unc/${[rawServer, share, ...pathComponents].join("/")}`;
    return {
      location: {
        name: pathComponents.at(-1) ?? share,
        path,
        wslPath,
        wslDistribution: null,
      },
    };
  }

  const components = normalizeProjectPathComponents(value, false);
  const path = components.length ? `/${components.join("/")}` : "/";
  return {
    location: {
      name: components.at(-1) ?? "/",
      path,
      wslPath: path,
      wslDistribution: null,
    },
  };
}

function resolvePreviewProjectFolder(input: string): ProjectFolderLocation {
  return resolvePreviewProjectPath(input).location;
}

function previewWslPath(projectPath?: string): string {
  if (!projectPath) return "/home/developer/project";
  return resolvePreviewProjectPath(projectPath).location.wslPath;
}

function mockReply(contact: Contact, lastText: string): string {
  if (contact.id === "service") {
    return "您好，这里是 OICQ 服务台。当前线路畅通，消息已成功送达。";
  }
  if (/在吗|在不在/.test(lastText)) return "在呢，刚看到消息。";
  if (/吃饭|晚饭/.test(lastText)) return "还没，正准备下楼。你呢？";
  if (/周末|明天|今晚/.test(lastText)) return "可以，我先把时间记下来，到时再联系。";
  if (/文件|照片/.test(lastText)) return "收到了，速度还挺快的。";
  const replies = [
    "好，我知道了。",
    "哈哈，这个界面一看就很亲切。",
    "没问题，晚一点再联系。",
    "消息收到，网络今天还挺稳定。",
  ];
  return replies[(mockMessageId + contact.id.length) % replies.length] ?? replies[0];
}

function mockTerminalExecution(
  command: string,
  contactId = TERMINAL_CONTACT_ID,
  projectPath?: string,
): TerminalExecution {
  const mockProjectRoot = previewWslPath(projectPath);
  const terminalContact = mockContacts.find((contact) => contact.id === contactId);
  const normalized = command.trim();
  const commandMessage: Message = {
    id: mockMessageId++,
    contactId,
    senderId: mockUser.id,
    senderName: mockUser.displayName,
    text: normalized,
    sentAt: Date.now(),
    outgoing: true,
    read: true,
  };
  const lower = normalized.toLocaleLowerCase();
  let output = "";
  if (lower === "help" || lower === "?") {
    output = "可用命令：help  pwd  ls  whoami  date  echo <文字>\n桌面版通过 wsl.exe 连接默认 Linux 发行版。";
  } else if (lower === "pwd") {
    output = mockProjectRoot;
  } else if (lower === "ls") {
    output = "README.md\npackage.json\nsrc\nsrc-tauri\nscripts";
  } else if (lower === "whoami") {
    output = "wsl-user";
  } else if (lower === "date") {
    output = new Date().toString();
  } else if (lower.startsWith("echo ")) {
    output = normalized.slice(5);
  } else {
    output = "浏览器预览不会启动 wsl.exe。请使用 Tauri 桌面版访问 WSL 终端。";
  }
  const outputMessage: Message = {
    id: mockMessageId++,
    contactId,
    senderId: contactId,
    senderName: terminalContact?.displayName ?? "项目终端",
    text: output || "(命令执行完成，没有输出)",
    sentAt: Date.now(),
    outgoing: false,
    read: true,
  };
  const conversation = mockMessages.get(contactId) ?? [];
  conversation.push(commandMessage, outputMessage);
  mockMessages.set(contactId, conversation);
  mockActiveContact = contactId;
  if (terminalContact) {
    terminalContact.lastMessage = outputMessage.text;
    terminalContact.lastMessageAt = outputMessage.sentAt;
  }
  return {
    commandMessage: clone(commandMessage),
    outputMessage: clone(outputMessage),
    cwd: mockProjectRoot,
    exitCode: 0,
    success: true,
  };
}

export const backend = {
  async bootstrap(): Promise<AppSnapshot> {
    if (isTauri()) return invoke<AppSnapshot>("bootstrap");
    return clone({
      currentUser: mockUser,
      contacts: mockContacts,
      messages: mockMessages.get(mockActiveContact) ?? [],
      activeContactId: mockActiveContact,
    });
  },

  async getConversation(contactId: string): Promise<Message[]> {
    if (isTauri()) {
      return invoke<Message[]>("get_conversation", { contactId });
    }
    mockActiveContact = contactId;
    return clone(mockMessages.get(contactId) ?? []);
  },

  async sendMessage(contactId: string, text: string): Promise<Message> {
    if (isTauri()) return invoke<Message>("send_message", { contactId, text });
    const contact = mockContacts.find((item) => item.id === contactId);
    if (!contact) throw new Error("联系人不存在");
    mockActiveContact = contactId;
    const message: Message = {
      id: mockMessageId++,
      contactId,
      senderId: mockUser.id,
      senderName: mockUser.displayName,
      text: text.trim(),
      sentAt: Date.now(),
      outgoing: true,
      read: true,
    };
    mockMessages.get(contactId)?.push(message);
    contact.lastMessage = message.text;
    contact.lastMessageAt = message.sentAt;
    return clone(message);
  },

  async generateReply(contactId: string): Promise<Message> {
    if (isTauri()) return invoke<Message>("generate_reply", { contactId });
    const contact = mockContacts.find((item) => item.id === contactId);
    if (!contact) throw new Error("联系人不存在");
    const conversation = mockMessages.get(contactId) ?? [];
    const lastText = [...conversation].reverse().find((item) => item.outgoing)?.text ?? "";
    const message: Message = {
      id: mockMessageId++,
      contactId,
      senderId: contact.id,
      senderName: contact.displayName,
      text: mockReply(contact, lastText),
      sentAt: Date.now(),
      outgoing: false,
      read: contactId === mockActiveContact,
    };
    conversation.push(message);
    mockMessages.set(contactId, conversation);
    contact.lastMessage = message.text;
    contact.lastMessageAt = message.sentAt;
    if (contactId !== mockActiveContact) contact.unreadCount += 1;
    return clone(message);
  },

  async markRead(contactId: string): Promise<Contact> {
    if (isTauri()) return invoke<Contact>("mark_read", { contactId });
    const contact = mockContacts.find((item) => item.id === contactId);
    if (!contact) throw new Error("联系人不存在");
    mockActiveContact = contactId;
    contact.unreadCount = 0;
    const messages = mockMessages.get(contactId) ?? [];
    messages.forEach((message) => {
      message.read = true;
    });
    return clone(contact);
  },

  async createTerminalContact(): Promise<Contact> {
    if (isTauri()) return invoke<Contact>("create_terminal_contact");
    let ordinal = 2;
    while (mockContacts.some((contact) => contact.id === `terminal-${ordinal}`)) {
      ordinal += 1;
    }
    const contact: Contact = {
      id: `terminal-${ordinal}`,
      displayName: `WSL 终端 ${ordinal}`,
      account: `WSL SHELL #${ordinal}`,
      avatarSeed: "terminal",
      presence: "online",
      statusMessage: "独立 WSL2 终端会话",
      group: "工具",
      unreadCount: 0,
      lastMessage: "等待启动 Linux shell。",
      lastMessageAt: Date.now(),
    };
    mockContacts.push(contact);
    mockMessages.set(contact.id, []);
    mockActiveContact = contact.id;
    return clone(contact);
  },

  async renameTerminalContact(
    contactId: string,
    displayName: string,
  ): Promise<Contact> {
    if (isTauri()) {
      return invoke<Contact>("rename_terminal_contact", { contactId, displayName });
    }
    if (!isTerminalContactId(contactId)) throw new Error("只能重命名 WSL 终端");
    const contact = mockContacts.find((item) => item.id === contactId);
    if (!contact) throw new Error("终端不存在");
    contact.displayName = normalizeTerminalName(displayName);
    return clone(contact);
  },

  async parseProjectFolder(path: string): Promise<ProjectFolderLocation> {
    if (isTauri()) return invoke<ProjectFolderLocation>("parse_project_folder", { path });
    return resolvePreviewProjectFolder(path);
  },

  async projectStorePath(): Promise<string> {
    if (isTauri()) return invoke<string>("project_store_path");
    throw new Error("浏览器预览没有外部项目数据文件");
  },

  async readProjectStore(): Promise<ProjectStore | null> {
    if (isTauri()) return invoke<ProjectStore | null>("read_project_store");
    return null;
  },

  async writeProjectStore(store: ProjectStore): Promise<void> {
    if (isTauri()) await invoke<void>("write_project_store", { store });
  },

  async openProjectStoreFile(): Promise<void> {
    if (isTauri()) await invoke<void>("open_project_store_file");
    else throw new Error("浏览器预览不支持打开项目数据文件");
  },

  async openProjectFolderInOneCommander(folder: ProjectFolder): Promise<void> {
    if (!isTauri()) throw new Error("仅 Windows 桌面版支持使用 OneCommander 打开项目文件夹");
    await invoke<void>("open_project_folder_in_onecommander", {
      path: folder.path,
      wslDistribution: folder.wslDistribution ?? undefined,
    });
  },

  async executeTerminal(
    command: string,
    contactId = TERMINAL_CONTACT_ID,
    projectPath?: string,
  ): Promise<TerminalExecution> {
    if (isTauri()) return invoke<TerminalExecution>("execute_terminal", { command });
    if (!command.trim()) throw new Error("命令不能为空");
    return mockTerminalExecution(command, contactId, projectPath);
  },

  async openPty(
    rows: number,
    cols: number,
    onData: (data: PtyData) => void,
    onExit: (exit: PtyExit) => void,
    project?: ProjectFolder,
  ): Promise<PtyOpenResult> {
    if (!isTauri()) return { sessionId: 0, project: null };
    const dataChannel = new Channel<PtyData>();
    dataChannel.onmessage = onData;
    const exitChannel = new Channel<PtyExit>();
    exitChannel.onmessage = onExit;
    return invoke<PtyOpenResult>("pty_open", {
      rows: Math.max(1, Math.round(rows)),
      cols: Math.max(2, Math.round(cols)),
      onData: dataChannel,
      onExit: exitChannel,
      projectPath: project?.path,
      projectWslPath: project?.wslPath,
      projectWslDistribution: project?.wslDistribution ?? undefined,
    });
  },

  async writePty(sessionId: number, data: Uint8Array): Promise<void> {
    if (!isTauri() || data.length === 0) return;
    return invoke<void>("pty_write", {
      sessionId,
      data: Array.from(data),
    });
  },

  async resizePty(sessionId: number, rows: number, cols: number): Promise<void> {
    if (!isTauri()) return;
    return invoke<void>("pty_resize", {
      sessionId,
      rows: Math.max(1, Math.round(rows)),
      cols: Math.max(2, Math.round(cols)),
    });
  },

  async closePty(sessionId: number): Promise<void> {
    if (!isTauri() || !sessionId) return;
    try {
      await invoke<void>("pty_close", { sessionId });
    } catch {
      // The shell may already have exited; closing an expired session is safe.
    }
  },

  async setPresence(presence: Presence): Promise<Contact> {
    if (isTauri()) return invoke<Contact>("set_presence", { presence });
    mockUser.presence = presence;
    return clone(mockUser);
  },
};
