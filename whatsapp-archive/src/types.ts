export type ImportRange =
  | { kind: "all" }
  | { kind: "last_days"; days: 30 | 90 | 180 }
  | { kind: "custom"; fromISO: string; toISO: string };

export interface ExportOptions {
  companyName: string;
  phoneNumber: string;
  responsibleName: string;
  notes?: string;
  range: ImportRange;
  includeGroups: boolean;
  includeMedia: boolean;
  includeDocuments: boolean;
  includeAudio: boolean;
  includeVideo: boolean;
  contactFilePath?: string;
  contactFileName?: string;
}

export type ExportStatus =
  | "created"
  | "connecting"
  | "qr_ready"
  | "authenticated"
  | "listing_chats"
  | "importing_messages"
  | "downloading_media"
  | "building_index"
  | "building_viewer"
  | "zipping"
  | "finished"
  | "cancelled"
  | "error"
  | "disconnected";

export interface ExportProgress {
  chatsFound: number;
  chatsImported: number;
  messagesImported: number;
  mediaDownloaded: number;
  mediaFailed: number;
  errors: number;
  startedAt?: string;
  finishedAt?: string;
  elapsedMs: number;
}

export interface ExportLogEntry {
  ts: string;
  level: "info" | "warn" | "error";
  message: string;
}

export interface ExportRecord {
  id: string;
  options: ExportOptions;
  status: ExportStatus;
  qrDataUrl?: string;
  progress: ExportProgress;
  logs: ExportLogEntry[];
  zipPath?: string;
  zipFileName?: string;
  errorMessage?: string;
  createdAt: string;
}

export interface ChatManifestEntry {
  id: string;
  name: string;
  displayName: string;
  contactName: string;
  verifiedName: string;
  pushName: string;
  shortName: string;
  phone: string;
  waId: string;
  rawId: string;
  isGroup: boolean;
  totalMessages: number;
  lastMessageAt: string | null;
  messagesFile: string;
  hasMedia: boolean;
  mediaCount: number;
}

export interface NormalizedMessage {
  id: string;
  timestamp: string;
  date: string;
  time: string;
  fromMe: boolean;
  senderName: string;
  senderPhone: string;
  type: string;
  body: string;
  mediaPath: string | null;
  fileName?: string;
  mimeType?: string;
  quotedMessageId: string | null;
}

export interface SearchIndexEntry {
  chatId: string;
  messageId: string;
  date: string;
  time: string;
  senderName: string;
  text: string;
}
