import { Client, LocalAuth, type Message, type Chat } from "whatsapp-web.js";
import QRCode from "qrcode";
import archiver from "archiver";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { findContactName, loadContactDirectory, normalizePhone, type ContactDirectory } from "./contacts";
import type {
  ChatManifestEntry,
  ExportLogEntry,
  ExportOptions,
  ExportRecord,
  ExportStatus,
  NormalizedMessage,
  SearchIndexEntry,
} from "./types";

const VIEWER_DIR = path.join(__dirname, "viewer");
const EXPORTER_VERSION = process.env.EXPORTER_VERSION || "1.1.6";
const MAX_MESSAGES_PER_CHAT = parseInt(process.env.MAX_MESSAGES_PER_CHAT || "20000", 10);
const SAFE_MODE = (process.env.SAFE_MODE || "true").toLowerCase() === "true";
const CHAT_DELAY_MS = parseInt(process.env.CHAT_DELAY_MS || "2500", 10);
const MEDIA_DELAY_MS = parseInt(process.env.MEDIA_DELAY_MS || "800", 10);
const MAX_CHATS_PER_RUN = parseInt(process.env.MAX_CHATS_PER_RUN || "0", 10);
const MAX_MEDIA_PER_RUN = parseInt(process.env.MAX_MEDIA_PER_RUN || "0", 10);
const DEEP_HISTORY_MODE = (process.env.DEEP_HISTORY_MODE || "false").toLowerCase() === "true";
const INITIAL_SYNC_WAIT_MS = parseInt(process.env.INITIAL_SYNC_WAIT_MS || "30000", 10);
const CHAT_SYNC_TIMEOUT_MS = parseInt(process.env.CHAT_SYNC_TIMEOUT_MS || "20000", 10);
const FETCH_RETRY_COUNT = parseInt(process.env.FETCH_RETRY_COUNT || "2", 10);
const FETCH_RETRY_DELAY_MS = parseInt(process.env.FETCH_RETRY_DELAY_MS || "3000", 10);
const PUPPETEER_PROTOCOL_TIMEOUT_MS = parseInt(process.env.PUPPETEER_PROTOCOL_TIMEOUT_MS || "900000", 10);
const GET_CHATS_TIMEOUT_MS = parseInt(process.env.GET_CHATS_TIMEOUT_MS || "900000", 10);
const TERMINAL_STATUSES = new Set<ExportStatus>(["finished", "error", "cancelled", "disconnected"]);

const SYNC_NOTICE =
  "AVISO: esta ferramenta importa apenas o histórico já sincronizado/disponível no WhatsApp Web no momento da exportação. " +
  "Mensagens antigas que o WhatsApp ainda não baixou para a sessão podem não aparecer.";

function nowIso() {
  return new Date().toISOString();
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message || String(error);
  return String(error);
}

function slug(s: string) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60) || "empresa";
}

function safeName(s: string) {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout em ${label} após ${ms}ms`)), ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function chatKey(chat: Chat): string {
  return chat.id?._serialized || `${chat.name || "sem_nome"}:${chat.timestamp || ""}`;
}

function cleanWaId(value: unknown): string {
  return String(value ?? "").replace(/@(c\.us|g\.us|lid|s\.whatsapp\.net|broadcast)$/i, "");
}

function fmtDate(d: Date) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = d.getFullYear();
  return `${dd}/${mm}/${yy}`;
}
function fmtTime(d: Date) {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function rangeFromOptions(opts: ExportOptions): { fromMs: number | null; toMs: number | null } {
  const r = opts.range;
  if (r.kind === "all") return { fromMs: null, toMs: null };
  if (r.kind === "last_days") {
    return { fromMs: Date.now() - r.days * 86400_000, toMs: null };
  }
  return {
    fromMs: r.fromISO ? new Date(r.fromISO).getTime() : null,
    toMs: r.toISO ? new Date(r.toISO).getTime() : null,
  };
}

function extForMime(mime?: string): string {
  if (!mime) return "bin";
  const m = mime.split(";")[0].trim();
  const map: Record<string, string> = {
    "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
    "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/wav": "wav",
    "video/mp4": "mp4", "video/3gpp": "3gp", "video/quicktime": "mov",
    "application/pdf": "pdf",
    "application/zip": "zip",
    "text/plain": "txt",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  };
  return map[m] || m.split("/")[1] || "bin";
}

export class ExportJob {
  record: ExportRecord;
  private client: Client | null = null;
  private cancelled = false;
  private startMs = 0;
  private workDir: string;
  private sessionDir: string;
  private exportDir: string;
  private clientId: string;
  private importStarted = false;
  private importFinished = false;
  private importPromise: Promise<void> | null = null;
  private allowNextTerminalExit = false;

  constructor(
    id: string,
    opts: ExportOptions,
    dirs: { tmp: string; sessions: string; exports: string }
  ) {
    this.record = {
      id,
      options: opts,
      status: "created",
      progress: {
        chatsFound: 0,
        chatsImported: 0,
        messagesImported: 0,
        mediaDownloaded: 0,
        mediaFailed: 0,
        errors: 0,
        elapsedMs: 0,
      },
      logs: [],
      createdAt: nowIso(),
    };
    this.clientId = `wa-${id}`;
    this.workDir = path.join(dirs.tmp, id);
    this.sessionDir = dirs.sessions;
    this.exportDir = dirs.exports;
  }

  private setStatus(s: ExportStatus, options?: { allowTerminalExit?: boolean }) {
    const allowTerminalExit = options?.allowTerminalExit || this.allowNextTerminalExit;
    if (TERMINAL_STATUSES.has(this.record.status) && s !== "error" && !allowTerminalExit) {
      this.log("warn", `status ${s} ignorado porque status atual é terminal: ${this.record.status}`);
      return;
    }

    if (allowTerminalExit) this.allowNextTerminalExit = false;
    this.record.status = s;
    this.log("info", `status: ${s}`);
  }

  log(level: ExportLogEntry["level"], message: string) {
    const entry: ExportLogEntry = { ts: nowIso(), level, message };
    this.record.logs.push(entry);
    if (this.record.logs.length > 2000) this.record.logs.splice(0, this.record.logs.length - 2000);
    const tag = level === "error" ? "ERR" : level === "warn" ? "WRN" : "INF";
    console.log(`[${this.record.id}] ${tag} ${message}`);
  }

  cancel() {
    this.cancelled = true;
    this.log("warn", "cancelamento solicitado");
  }

  async stopAndDisconnect() {
    this.cancelled = true;
    if (this.client) {
      const client = this.client;
      try { await client.logout(); } catch { /* a sessão pode já estar desconectada */ }
      try { await client.destroy(); } catch { /* ignore */ }
      this.client = null;
    }
    await this.removeContactFile();
    const sess = path.join(this.sessionDir, `session-${this.clientId}`);
    await fsp.rm(sess, { recursive: true, force: true }).catch(() => {});
    this.setStatus("disconnected");
    this.log("info", "Sessão desconectada e credenciais locais removidas. ZIPs preservados.");
  }

  async disconnect() {
    if (this.client) {
      const client = this.client;
      try { await client.destroy(); } catch { /* ignore */ }
      this.client = null;
    }
  }

  async cleanup() {
    await this.stopAndDisconnect();
    await fsp.rm(this.workDir, { recursive: true, force: true }).catch(() => {});
    if (this.record.zipPath) {
      await fsp.rm(this.record.zipPath, { force: true }).catch(() => {});
      this.record.zipPath = undefined;
    }
    this.log("info", "sessão, arquivos temporários e ZIP apagados");
  }

  private async removeContactFile() {
    if (this.record.options.contactFilePath) {
      await fsp.rm(this.record.options.contactFilePath, { force: true }).catch(() => {});
      this.record.options.contactFilePath = undefined;
    }
  }

  async start() {
    this.startMs = Date.now();
    this.record.progress.startedAt = nowIso();
    await fsp.mkdir(this.workDir, { recursive: true });
    await fsp.mkdir(path.join(this.workDir, "data"), { recursive: true });
    await fsp.mkdir(path.join(this.workDir, "media"), { recursive: true });

    this.setStatus("connecting");
    this.log("warn", SYNC_NOTICE);
    if (SAFE_MODE) this.log("info", "Modo conservador ativo");
    this.log("info", `PUPPETEER_PROTOCOL_TIMEOUT_MS=${PUPPETEER_PROTOCOL_TIMEOUT_MS}`);
    this.log("info", `GET_CHATS_TIMEOUT_MS=${GET_CHATS_TIMEOUT_MS}`);
    this.client = new Client({
      authStrategy: new LocalAuth({ clientId: this.clientId, dataPath: this.sessionDir }),
      puppeteer: {
        headless: true,
        protocolTimeout: PUPPETEER_PROTOCOL_TIMEOUT_MS,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-gpu",
          "--no-first-run",
          "--no-zygote",
        ],
      },
    });

    this.client.on("qr", async (qr) => {
      try {
        this.record.qrDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 1 });
        this.setStatus("qr_ready");
        this.log("info", "QR Code gerado, aguardando leitura");
      } catch (e) {
        this.log("error", `falha ao gerar QR: ${(e as Error).message}`);
      }
    });

    this.client.on("authenticated", () => {
      this.record.qrDataUrl = undefined;
      this.setStatus("authenticated");
    });

    this.client.on("auth_failure", (msg) => {
      this.log("error", `falha de autenticação: ${msg}`);
      this.fail(new Error("Falha de autenticação no WhatsApp"));
    });

    this.client.on("disconnected", (reason) => {
      this.log("warn", `WhatsApp desconectado: ${reason}`);
      this.client = null;
    });

    this.client.once("ready", () => {
      this.log("info", "cliente pronto");
      this.setStatus("ready");
      this.startImportOnce();
    });

    try {
      await this.client.initialize();
    } catch (e) {
      this.fail(e as Error);
    }
  }

  public async retryImport() {
    const allowed: ExportStatus[] = ["error", "authenticated", "ready", "listing_chats"];
    if (!allowed.includes(this.record.status)) {
      throw new Error(`retry não permitido em status ${this.record.status}`);
    }

    if (this.importPromise) {
      throw new Error("já existe uma tentativa de importação em andamento");
    }

    this.log("info", `retry solicitado; status atual=${this.record.status}; lastFailedStage=${this.record.lastFailedStage || "nenhum"}`);
    this.cancelled = false;
    this.record.errorMessage = undefined;
    this.importStarted = false;
    this.importFinished = false;
    this.importPromise = null;

    if (!this.client) {
      this.log("warn", "client não existe mais; reinicializando com a mesma sessão LocalAuth");
      this.allowNextTerminalExit = true;
      await this.start();
      return;
    }

    this.log("info", "tentando novamente usando a sessão WhatsApp atual");
    this.startImportOnce({ force: true });
  }

  private startImportOnce(options?: { force?: boolean }) {
    if (this.importStarted && !options?.force) {
      this.log("warn", "importação já estava em execução, ignorando");
      return;
    }

    if (!options?.force && ["finished", "cancelled", "error", "disconnected"].includes(this.record.status)) {
      this.log("warn", `evento ready ignorado porque status atual é ${this.record.status}`);
      return;
    }

    if (options?.force) this.allowNextTerminalExit = true;
    this.importStarted = true;
    this.importFinished = false;
    const promise = this.runImport()
      .then(() => { this.importFinished = true; })
      .catch((e) => this.fail(e))
      .finally(() => {
        if (this.importPromise === promise) this.importPromise = null;
      });
    this.importPromise = promise;
  }

  private fail(err: unknown) {
    this.importStarted = false;
    this.importFinished = false;
    this.importPromise = null;

    const message = formatError(err);
    this.record.errorMessage = message;
    this.record.progress.errors += 1;
    this.setStatus("error");
    this.log("error", err instanceof Error ? err.stack || message : message);
    this.finalizeTimer();
  }

  private finalizeTimer() {
    this.record.progress.elapsedMs = Date.now() - this.startMs;
    this.record.progress.finishedAt = nowIso();
  }

  private throwIfCancelled() {
    if (this.cancelled) {
      const e = new Error("cancelado pelo usuário");
      (e as Error & { __cancelled?: boolean }).__cancelled = true;
      throw e;
    }
  }

  private async runImport() {
    try {
      if (!this.client) throw new Error("cliente WhatsApp não inicializado");
      const opts = this.record.options;

      this.startMs = Date.now();
      this.record.progress.chatsFound = 0;
      this.record.progress.chatsImported = 0;
      this.record.progress.messagesImported = 0;
      this.record.progress.mediaDownloaded = 0;
      this.record.progress.mediaFailed = 0;
      this.record.progress.errors = 0;
      this.record.progress.elapsedMs = 0;
      this.record.progress.startedAt = nowIso();
      this.record.progress.finishedAt = undefined;

      this.log("info", `MAX_MESSAGES_PER_CHAT=${MAX_MESSAGES_PER_CHAT}`);
      this.log("info", `DEEP_HISTORY_MODE=${DEEP_HISTORY_MODE}`);
      this.log("info", `MAX_CHATS_PER_RUN=${MAX_CHATS_PER_RUN}`);
      this.log("info", `MAX_MEDIA_PER_RUN=${MAX_MEDIA_PER_RUN}`);
      if (DEEP_HISTORY_MODE && INITIAL_SYNC_WAIT_MS > 0) {
        this.log("info", `aguardando sincronização inicial por ${INITIAL_SYNC_WAIT_MS}ms`);
        await sleep(INITIAL_SYNC_WAIT_MS);
        this.throwIfCancelled();
      }

      this.setStatus("listing_chats");
      this.log("info", `iniciando getChats() com timeout ${GET_CHATS_TIMEOUT_MS}ms`);
      let rawChats: Chat[];
      try {
        rawChats = await withTimeout(this.client.getChats(), GET_CHATS_TIMEOUT_MS, "getChats()");
      } catch (error) {
        const message = (error as Error).message || String(error);
        const stack = (error as Error).stack || "";
        if (message.includes("Runtime.callFunctionOn timed out") || message.includes("ProtocolError") || stack.includes("ProtocolError") || message.includes("timeout em getChats")) {
          const friendly = "Timeout ao listar chats no WhatsApp Web. A sessão está autenticada, mas o WhatsApp Web demorou demais para retornar as conversas. Você pode tentar novamente sem ler novo QR Code.";
          this.record.lastFailedStage = "listing_chats";
          this.log("error", "lastFailedStage=listing_chats");
          this.log("error", friendly);
          throw new Error(friendly, { cause: error });
        }
        this.record.lastFailedStage = "listing_chats";
        this.log("error", "lastFailedStage=listing_chats");
        throw error;
      }
      this.record.lastFailedStage = undefined;
      this.log("info", `getChats retornou ${rawChats.length} conversas`);
      const filteredChats = rawChats.filter((c) =>
        opts.includeGroups ? true : !c.isGroup
      );
      const seen = new Set<string>();
      const uniqueChats = filteredChats.filter((chat) => {
        const key = chatKey(chat);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const chats = MAX_CHATS_PER_RUN > 0 ? uniqueChats.slice(0, MAX_CHATS_PER_RUN) : uniqueChats;
      this.record.progress.chatsFound = chats.length;
      this.log("info", `chats encontrados: ${rawChats.length}; filtrados/deduplicados: ${chats.length}`);
      if (MAX_CHATS_PER_RUN > 0 && uniqueChats.length > chats.length) {
        this.log("warn", `limite MAX_CHATS_PER_RUN=${MAX_CHATS_PER_RUN} atingido`);
      }

      const contacts = await loadContactDirectory(opts.contactFilePath).catch((error) => {
        this.log("warn", `agenda não pôde ser lida: ${(error as Error).message}`);
        return new Map() as ContactDirectory;
      });
      if (contacts.size) this.log("info", `agenda carregada: ${contacts.size} telefone(s)`);

      const { fromMs, toMs } = rangeFromOptions(opts);
      const chatManifest: ChatManifestEntry[] = [];
      const searchIndex: SearchIndexEntry[] = [];
      let importedMessagesTotal = 0;

      this.setStatus("importing_messages");
      let idx = 0;
      for (const chat of chats) {
        this.throwIfCancelled();
        if (SAFE_MODE && idx > 0) await sleep(CHAT_DELAY_MS);
        idx += 1;
        const chatId = `chat_${String(idx).padStart(3, "0")}`;
        const chatMediaDir = path.join(this.workDir, "media", chatId);

        try {
          const fetched = await this.fetchChatMessages(chat, fromMs, toMs);
          const normalized: NormalizedMessage[] = [];

          for (const m of fetched) {
            this.throwIfCancelled();
            const ts = (m.timestamp || 0) * 1000;
            const d = new Date(ts);
            const norm: NormalizedMessage = {
              id: m.id?._serialized || crypto.randomUUID(),
              timestamp: d.toISOString(),
              date: fmtDate(d),
              time: fmtTime(d),
              fromMe: !!m.fromMe,
              senderName: (m as unknown as { _data?: { notifyName?: string } })._data?.notifyName
                || (m.author || m.from || "").replace(/@.*/, ""),
              senderPhone: (m.author || m.from || "").replace(/@c\.us|@g\.us/, ""),
              type: m.type || "chat",
              body: m.body || "",
              mediaPath: null,
              quotedMessageId: m.hasQuotedMsg ? (m as unknown as { _data?: { quotedStanzaID?: string } })._data?.quotedStanzaID || null : null,
            };

            const mediaLimitReached = MAX_MEDIA_PER_RUN > 0 && this.record.progress.mediaDownloaded >= MAX_MEDIA_PER_RUN;
            if (m.hasMedia && this.shouldDownloadMedia(m.type) && !mediaLimitReached) {
              try {
                if (SAFE_MODE) await sleep(MEDIA_DELAY_MS);
                const media = await m.downloadMedia();
                if (media && media.data) {
                  await fsp.mkdir(chatMediaDir, { recursive: true });
                  const ext = extForMime(media.mimetype);
                  // sempre prefixa com messageId/uuid para evitar colisões
                  const uid = (norm.id || crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 40);
                  const baseFromWa = media.filename ? safeName(media.filename) : `${uid}.${ext}`;
                  const fname = media.filename ? `${uid}__${baseFromWa}` : baseFromWa;
                  const rel = path.posix.join("media", chatId, fname);
                  const abs = path.join(this.workDir, rel);
                  await fsp.writeFile(abs, Buffer.from(media.data, "base64"));
                  norm.mediaPath = rel;
                  norm.fileName = media.filename ? safeName(media.filename) : fname;
                  norm.mimeType = media.mimetype;
                  this.record.progress.mediaDownloaded += 1;
                }
              } catch (e) {
                this.record.progress.mediaFailed += 1;
                this.log("warn", `falha ao baixar mídia (${chatId}/${norm.id}): ${(e as Error).message}`);
              }
            }

            normalized.push(norm);

            if (norm.body && norm.type !== "revoked") {
              searchIndex.push({
                chatId,
                messageId: norm.id,
                date: norm.date,
                time: norm.time,
                senderName: norm.senderName,
                text: norm.body.slice(0, 280),
              });
            }
          }

          const messagesFile = `data/messages_${chatId}.js`;
          const payload =
            `window.MESSAGES_${chatId} = ${JSON.stringify(normalized, null, 2)};\n`;
          await fsp.writeFile(path.join(this.workDir, messagesFile), payload, "utf8");

          const last = normalized.at(-1);
          const mediaCount = normalized.filter((n) => !!n.mediaPath).length;
          const chatDetails = await this.resolveChatDetails(chat, contacts);
          chatManifest.push({
            id: chatId,
            name: chatDetails.displayName,
            ...chatDetails,
            isGroup: !!chat.isGroup,
            totalMessages: normalized.length,
            lastMessageAt: last ? last.timestamp : null,
            messagesFile,
            hasMedia: mediaCount > 0,
            mediaCount,
          });

          this.record.progress.chatsImported = chatManifest.length;
          importedMessagesTotal += normalized.length;
          this.record.progress.messagesImported = importedMessagesTotal;
          this.record.progress.elapsedMs = Date.now() - this.startMs;
          this.log("info", `chat ${chatId} (${chatDetails.displayName}) importado: ${normalized.length} mensagens`);
        } catch (e) {
          if ((e as Error & { __cancelled?: boolean }).__cancelled) throw e;
          this.record.progress.errors += 1;
          this.log("error", `erro no chat ${chatId}: ${(e as Error).message}`);
        }
      }

      if (MAX_MEDIA_PER_RUN > 0 && this.record.progress.mediaDownloaded >= MAX_MEDIA_PER_RUN) {
        this.log("warn", `limite MAX_MEDIA_PER_RUN=${MAX_MEDIA_PER_RUN} atingido; demais mídias não foram baixadas`);
      }

      this.setStatus("building_index");
      await fsp.writeFile(
        path.join(this.workDir, "data/chats.js"),
        `window.CHATS = ${JSON.stringify(chatManifest, null, 2)};\n`,
        "utf8"
      );
      await fsp.writeFile(
        path.join(this.workDir, "data/search_index.js"),
        `window.SEARCH_INDEX = ${JSON.stringify(searchIndex)};\n`,
        "utf8"
      );

      this.setStatus("building_viewer");
      await this.copyViewer();
      await this.writeManifest(chatManifest.length);

      this.log("info", `resumo final: chatsFound=${this.record.progress.chatsFound}, chatsImported=${chatManifest.length}, messagesImported=${importedMessagesTotal}`);

      this.setStatus("zipping");
      const zipPath = await this.zipResult();
      this.record.zipPath = zipPath;
      this.record.zipFileName = path.basename(zipPath);

      this.finalizeTimer();
      this.setStatus("finished");
      this.log("info", `exportação concluída em ${(this.record.progress.elapsedMs/1000).toFixed(1)}s`);
      // mantém o cliente WhatsApp vivo até o usuário clicar "desconectar".
    } catch (e) {
      if ((e as Error & { __cancelled?: boolean }).__cancelled) {
        this.setStatus("cancelled");
        this.finalizeTimer();
        await this.disconnect().catch(() => {});
        return;
      }
      throw e;
    } finally {
      if (["finished", "cancelled", "disconnected"].includes(this.record.status)) await this.removeContactFile();
    }
  }

  private async resolveChatDetails(chat: Chat, contacts: ContactDirectory) {
    const formattedTitle = (chat as unknown as { formattedTitle?: string }).formattedTitle || "";
    const contact = await chat.getContact().catch(() => null);
    const data = contact as unknown as {
      name?: string; verifiedName?: string; pushname?: string; shortName?: string;
      number?: string; id?: { user?: string; _serialized?: string };
    } | null;
    const rawId = chat.id?._serialized || data?.id?._serialized || "";
    const waId = cleanWaId(data?.id?._serialized || rawId);
    const phone = normalizePhone(data?.number || data?.id?.user || chat.id?.user || cleanWaId(rawId));
    const contactName = data?.name?.trim() || "";
    const verifiedName = data?.verifiedName?.trim() || "";
    const pushName = data?.pushname?.trim() || "";
    const shortName = data?.shortName?.trim() || "";
    const agendaName = findContactName(contacts, phone);
    const individualCandidates = [agendaName, contactName, verifiedName, pushName, shortName, chat.name, formattedTitle, data?.number, chat.id?.user, cleanWaId(rawId)];
    const groupCandidates = [chat.name, formattedTitle, cleanWaId(rawId)];
    const displayName = (chat.isGroup ? groupCandidates : individualCandidates)
      .map((value) => String(value ?? "").trim())
      .find((value) => value && !/@lid$/i.test(value)) || phone || waId || cleanWaId(rawId) || "Contato sem nome";
    return { displayName, contactName, verifiedName, pushName, shortName, phone, waId, rawId };
  }

  private shouldDownloadMedia(type: string): boolean {
    const o = this.record.options;
    if (!o.includeMedia) return false;
    if (type === "image" || type === "sticker") return true;
    if (type === "video" || type === "gif") return o.includeVideo;
    if (type === "audio" || type === "ptt" || type === "voice") return o.includeAudio;
    if (type === "document") return o.includeDocuments;
    return false;
  }

  private async fetchChatMessages(chat: Chat, fromMs: number | null, toMs: number | null): Promise<Message[]> {
    // whatsapp-web.js carrega apenas as mensagens já sincronizadas no WhatsApp Web.
    const limit = MAX_MESSAGES_PER_CHAT;
    const chatLabel = chat.name || chat.id?._serialized || "chat sem identificação";
    const maybeSync = (chat as unknown as { syncHistory?: () => Promise<unknown> }).syncHistory;

    if (DEEP_HISTORY_MODE && typeof maybeSync === "function") {
      this.log("info", `sincronizando histórico do chat "${chatLabel}"`);
      await Promise.race([
        maybeSync.call(chat),
        sleep(CHAT_SYNC_TIMEOUT_MS).then(() => "timeout"),
      ]).catch((e) => {
        this.log("warn", `syncHistory falhou no chat "${chatLabel}": ${(e as Error).message}`);
      });
    }

    let msgs = await chat.fetchMessages({ limit });
    for (let attempt = 1; attempt <= FETCH_RETRY_COUNT; attempt += 1) {
      if (!DEEP_HISTORY_MODE || msgs.length >= limit) break;
      await sleep(FETCH_RETRY_DELAY_MS);
      const again = await chat.fetchMessages({ limit });
      if (again.length <= msgs.length) break;
      msgs = again;
    }

    this.log("info", `chat "${chatLabel}" fetchMessages retornou ${msgs.length} mensagens`);
    if (msgs.length <= 3) {
      this.log("warn", `chat "${chatLabel}" retornou apenas ${msgs.length} mensagem(ns); provável histórico não sincronizado no WhatsApp Web`);
    }
    if (msgs.length >= limit) {
      this.log(
        "warn",
        `chat "${chatLabel}" atingiu o limite MAX_MESSAGES_PER_CHAT=${limit}. Mensagens mais antigas podem ter sido truncadas. ${SYNC_NOTICE}`
      );
    }
    return msgs.filter((m) => {
      const ts = (m.timestamp || 0) * 1000;
      if (fromMs && ts < fromMs) return false;
      if (toMs && ts > toMs) return false;
      return true;
    });
  }

  private async copyViewer() {
    const files = ["index.html", "app.js", "style.css", "README.html"];
    for (const f of files) {
      const src = path.join(VIEWER_DIR, f);
      const dst = path.join(this.workDir, f);
      await fsp.copyFile(src, dst);
    }
  }

  private async writeManifest(chatsTotal: number) {
    const o = this.record.options;
    const hash = crypto
      .createHash("sha256")
      .update(`${this.record.id}|${o.companyName}|${o.phoneNumber}|${Date.now()}`)
      .digest("hex")
      .slice(0, 16);

    const manifest = {
      product: "Telenova WhatsApp Archive",
      exporterVersion: EXPORTER_VERSION,
      exportId: this.record.id,
      exportHash: hash,
      exportedAt: nowIso(),
      company: o.companyName,
      phoneNumber: o.phoneNumber,
      responsible: o.responsibleName,
      notes: o.notes || "",
      totals: {
        chats: chatsTotal,
        messages: this.record.progress.messagesImported,
        media: this.record.progress.mediaDownloaded,
      },
      range: o.range,
      includes: {
        groups: o.includeGroups,
        media: o.includeMedia,
        documents: o.includeDocuments,
        audio: o.includeAudio,
        video: o.includeVideo,
      },
      notice: SYNC_NOTICE,
      limits: {
        maxMessagesPerChat: MAX_MESSAGES_PER_CHAT,
        deepHistoryMode: DEEP_HISTORY_MODE,
        initialSyncWaitMs: INITIAL_SYNC_WAIT_MS,
        fetchRetryCount: FETCH_RETRY_COUNT,
      },
    };
    await fsp.writeFile(
      path.join(this.workDir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf8"
    );
    await fsp.writeFile(
      path.join(this.workDir, "data/manifest.js"),
      `window.MANIFEST = ${JSON.stringify(manifest)};\n`,
      "utf8"
    );
    const notice =
      `Telenova WhatsApp Archive\n` +
      `==========================\n\n` +
      `${SYNC_NOTICE}\n\n` +
      `Limite por chat nesta exportação: ${MAX_MESSAGES_PER_CHAT} mensagens (MAX_MESSAGES_PER_CHAT).\n` +
      `Mesmo com um limite alto, chats podem retornar poucas mensagens quando o histórico não está sincronizado.\n` +
      `DEEP_HISTORY_MODE=${DEEP_HISTORY_MODE} tenta melhorar a sincronização, mas não garante 100% do histórico.\n` +
      `Empresa: ${o.companyName}\nTelefone: ${o.phoneNumber}\nResponsável: ${o.responsibleName}\n` +
      `Exportado em: ${nowIso()}\nExportID: ${this.record.id}\n`;
    await fsp.writeFile(path.join(this.workDir, "AVISO.txt"), notice, "utf8");
  }

  private async zipResult(): Promise<string> {
    const folder = `historico-whatsapp-${slug(this.record.options.companyName)}`;
    const zipName = `${folder}-${this.record.id}.zip`;
    const zipPath = path.join(this.exportDir, zipName);
    await fsp.mkdir(this.exportDir, { recursive: true });

    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(zipPath);
      const arc = archiver("zip", { zlib: { level: 9 } });
      out.on("close", () => resolve());
      out.on("error", reject);
      arc.on("error", reject);
      arc.pipe(out);
      arc.directory(this.workDir, folder);
      arc.finalize();
    });

    this.log("info", `ZIP gerado: ${zipName}`);
    return zipPath;
  }
}

export class ExportManager {
  private jobs = new Map<string, ExportJob>();
  constructor(
    private dirs: { tmp: string; sessions: string; exports: string },
    private opts: { maxConcurrent: number } = { maxConcurrent: 1 }
  ) {}

  list(): ExportRecord[] {
    return Array.from(this.jobs.values())
      .map((j) => j.record)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  get(id: string) { return this.jobs.get(id); }

  activeCount(): number {
    const ACTIVE: ExportRecord["status"][] = [
      "created","connecting","qr_ready","authenticated","listing_chats",
      "importing_messages","downloading_media","building_index","building_viewer","zipping",
    ];
    return this.list().filter((r) => ACTIVE.includes(r.status)).length;
  }

  /** Cria o job e dispara start() em background. Retorna imediatamente. */
  createAndStart(opts: ExportOptions): ExportJob {
    if (this.activeCount() >= this.opts.maxConcurrent) {
      throw new Error(`limite de ${this.opts.maxConcurrent} exportação(ões) ativa(s) atingido`);
    }
    const id = crypto.randomUUID().slice(0, 8);
    const job = new ExportJob(id, opts, this.dirs);
    this.jobs.set(id, job);
    // dispara sem aguardar
    job.start().catch((e) => {
      job.log("error", `start falhou: ${(e as Error).message}`);
    });
    return job;
  }

  async remove(id: string) {
    const j = this.jobs.get(id);
    if (!j) return;
    await j.cleanup();
    this.jobs.delete(id);
  }
}
