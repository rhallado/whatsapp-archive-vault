import { Client, LocalAuth, type Message, type Chat } from "whatsapp-web.js";
import QRCode from "qrcode";
import archiver from "archiver";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
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
const EXPORTER_VERSION = process.env.EXPORTER_VERSION || "1.0.0";
const MAX_MESSAGES_PER_CHAT = parseInt(process.env.MAX_MESSAGES_PER_CHAT || "20000", 10);

const SYNC_NOTICE =
  "AVISO: esta ferramenta importa apenas o histórico já sincronizado/disponível no WhatsApp Web no momento da exportação. " +
  "Mensagens antigas que o WhatsApp ainda não baixou para a sessão podem não aparecer.";

function nowIso() {
  return new Date().toISOString();
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

  private setStatus(s: ExportStatus) {
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

  async disconnect() {
    if (this.client) {
      try { await this.client.destroy(); } catch { /* ignore */ }
      this.client = null;
      this.setStatus("disconnected");
    }
  }

  async cleanup() {
    await this.disconnect();
    await fsp.rm(this.workDir, { recursive: true, force: true }).catch(() => {});
    const sess = path.join(this.sessionDir, `session-${this.clientId}`);
    await fsp.rm(sess, { recursive: true, force: true }).catch(() => {});
    if (this.record.zipPath) {
      await fsp.rm(this.record.zipPath, { force: true }).catch(() => {});
      this.record.zipPath = undefined;
    }
    this.log("info", "dados temporários apagados");
  }

  async start() {
    this.startMs = Date.now();
    this.record.progress.startedAt = nowIso();
    await fsp.mkdir(this.workDir, { recursive: true });
    await fsp.mkdir(path.join(this.workDir, "data"), { recursive: true });
    await fsp.mkdir(path.join(this.workDir, "media"), { recursive: true });

    this.setStatus("connecting");
    this.log("warn", SYNC_NOTICE);
    this.client = new Client({
      authStrategy: new LocalAuth({ clientId: this.clientId, dataPath: this.sessionDir }),
      puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--no-first-run",
          "--no-zygote",
          "--single-process",
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
    });

    this.client.on("ready", () => {
      this.log("info", "cliente pronto");
      this.runImport().catch((e) => this.fail(e));
    });

    try {
      await this.client.initialize();
    } catch (e) {
      this.fail(e as Error);
    }
  }

  private fail(err: Error) {
    this.record.errorMessage = err.message;
    this.record.progress.errors += 1;
    this.setStatus("error");
    this.log("error", err.stack || err.message);
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

      this.setStatus("listing_chats");
      const chats = (await this.client.getChats()).filter((c) =>
        opts.includeGroups ? true : !c.isGroup
      );
      this.record.progress.chatsFound = chats.length;
      this.log("info", `chats encontrados: ${chats.length}`);

      const { fromMs, toMs } = rangeFromOptions(opts);
      const chatManifest: ChatManifestEntry[] = [];
      const searchIndex: SearchIndexEntry[] = [];

      this.setStatus("importing_messages");
      let idx = 0;
      for (const chat of chats) {
        this.throwIfCancelled();
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

            if (m.hasMedia && this.shouldDownloadMedia(m.type)) {
              try {
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
          chatManifest.push({
            id: chatId,
            name: chat.name || (chat as unknown as { formattedTitle?: string }).formattedTitle || chat.id._serialized,
            phone: chat.id._serialized.replace(/@c\.us|@g\.us/, ""),
            isGroup: !!chat.isGroup,
            totalMessages: normalized.length,
            lastMessageAt: last ? last.timestamp : null,
            messagesFile,
            hasMedia: mediaCount > 0,
            mediaCount,
          });

          this.record.progress.chatsImported += 1;
          this.record.progress.messagesImported += normalized.length;
          this.record.progress.elapsedMs = Date.now() - this.startMs;
          this.log("info", `chat ${chatId} (${chat.name}) importado: ${normalized.length} mensagens`);
        } catch (e) {
          if ((e as Error & { __cancelled?: boolean }).__cancelled) throw e;
          this.record.progress.errors += 1;
          this.log("error", `erro no chat ${chatId}: ${(e as Error).message}`);
        }
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
      this.fail(e as Error);
    }
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
    const msgs = await chat.fetchMessages({ limit });
    if (msgs.length >= limit) {
      this.log(
        "warn",
        `chat "${chat.name}" atingiu o limite MAX_MESSAGES_PER_CHAT=${limit}. Mensagens mais antigas podem ter sido truncadas. ${SYNC_NOTICE}`
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
      limits: { maxMessagesPerChat: MAX_MESSAGES_PER_CHAT },
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
  constructor(private dirs: { tmp: string; sessions: string; exports: string }) {}

  list(): ExportRecord[] {
    return Array.from(this.jobs.values())
      .map((j) => j.record)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  get(id: string) { return this.jobs.get(id); }

  async create(opts: ExportOptions): Promise<ExportJob> {
    const id = crypto.randomUUID().slice(0, 8);
    const job = new ExportJob(id, opts, this.dirs);
    this.jobs.set(id, job);
    await job.start();
    return job;
  }

  async remove(id: string) {
    const j = this.jobs.get(id);
    if (!j) return;
    await j.cleanup();
    this.jobs.delete(id);
  }
}
