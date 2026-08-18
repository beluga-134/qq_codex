export type Presence = "online" | "away" | "busy" | "offline";

export const TERMINAL_CONTACT_ID = "terminal";
export const PROJECT_CONTACT_PREFIX = "project-folder:";

export interface ProjectFolder {
  id: string;
  directoryId: string;
  name: string;
  path: string;
  wslPath?: string;
  wslDistribution?: string | null;
}

export interface ProjectDirectory {
  id: string;
  name: string;
}

export interface ProjectFolderLocation {
  name: string;
  path: string;
  wslPath: string;
  wslDistribution: string | null;
}

export interface Contact {
  id: string;
  displayName: string;
  account: string;
  avatarSeed: string;
  presence: Presence;
  statusMessage: string;
  group: string;
  unreadCount: number;
  lastMessage: string;
  lastMessageAt: number;
}

export interface Message {
  id: number;
  contactId: string;
  senderId: string;
  senderName: string;
  text: string;
  sentAt: number;
  outgoing: boolean;
  read: boolean;
}

export interface AppSnapshot {
  currentUser: Contact;
  contacts: Contact[];
  messages: Message[];
  activeContactId: string;
}

export interface TerminalExecution {
  commandMessage: Message;
  outputMessage: Message;
  cwd: string;
  exitCode: number | null;
  success: boolean;
}
