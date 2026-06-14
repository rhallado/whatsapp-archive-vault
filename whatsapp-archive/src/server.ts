import express, { type Request, type Response, type NextFunction } from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import fs from "node:fs";
import multer from "multer";
import crypto from "node:crypto";
import { ExportManager } from "./exporter";
import type { ExportOptions } from "./types";

const PORT = parseInt(process.env.PORT || "3000", 10);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const SESSION_DIR = process.env.SESSION_DIR || "/data/sessions";
const EXPORT_DIR = process.env.EXPORT_DIR || "/data/exports";
const TMP_DIR = process.env.TMP_DIR || "/data/tmp";
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_EXPORTS || "1", 10);
const CODE_VERSION = "1.1.4";
const APP_VERSION = CODE_VERSION;

if (!ADMIN_TOKEN || ADMIN_TOKEN.length < 12) {
  console.error("ADMIN_TOKEN ausente ou muito curto (mínimo 12 chars). Abortando.");
  process.exit(1);
}

for (const d of [SESSION_DIR, EXPORT_DIR, TMP_DIR]) fs.mkdirSync(d, { recursive: true });

interface ZipFileInfo {
  id: string;
  zipFileName: string;
  zipPath: string;
  size: number;
  mtime: string;
  createdAt: string;
}

function extractExportId(fileName: string): string | null {
  return fileName.match(/-([a-zA-Z0-9]{8})\.zip$/i)?.[1] || null;
}

function listZipFiles(): ZipFileInfo[] {
  try {
    return fs.readdirSync(EXPORT_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".zip"))
      .flatMap((entry) => {
        const id = extractExportId(entry.name);
        if (!id) return [];
        const zipPath = path.join(EXPORT_DIR, entry.name);
        const stat = fs.statSync(zipPath);
        return [{ id, zipFileName: entry.name, zipPath, size: stat.size, mtime: stat.mtime.toISOString(), createdAt: stat.mtime.toISOString() }];
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
  } catch (error) {
    console.error("failed to list export ZIPs", { exportDir: EXPORT_DIR, error });
    return [];
  }
}

function findZipByExportId(id: string): ZipFileInfo | null {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return null;
  return listZipFiles().find((zip) => zip.id === id || zip.zipFileName.includes(id)) || null;
}

function fileStatus(zip: ZipFileInfo) {
  return {
    id: zip.id,
    status: "file_available" as const,
    zipFileName: zip.zipFileName,
    size: zip.size,
    createdAt: zip.createdAt,
    mtime: zip.mtime,
    logicalPath: `/data/exports/${zip.zipFileName}`,
    downloadUrl: `/api/export/${encodeURIComponent(zip.id)}/download`,
  };
}

function companyFromZipName(fileName: string, id: string): string {
  const value = fileName.replace(/^historico-whatsapp-/i, "").replace(new RegExp(`-${id}\\.zip$`, "i"), "");
  return value.split("-").filter(Boolean).map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ") || "Arquivo exportado";
}

function publicOptions(options: ExportOptions) {
  const { contactFilePath: _privatePath, ...safe } = options;
  return safe;
}

function publicRecord(record: ReturnType<ExportManager["list"]>[number]) {
  return { ...record, options: publicOptions(record.options) };
}

const manager = new ExportManager(
  { tmp: TMP_DIR, sessions: SESSION_DIR, exports: EXPORT_DIR },
  { maxConcurrent: MAX_CONCURRENT }
);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== ".csv" && ext !== ".vcf") return callback(new Error("agenda deve ser .csv ou .vcf"));
    callback(null, true);
  },
});

// ---- Auth ----
function authed(req: Request): boolean {
  const cookie = req.cookies?.tn_admin;
  const header = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  return cookie === ADMIN_TOKEN || header === ADMIN_TOKEN;
}
function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!authed(req)) return res.status(401).json({ error: "unauthorized" });
  next();
}

app.post("/api/auth/login", (req, res) => {
  const { token } = req.body || {};
  if (typeof token !== "string" || token !== ADMIN_TOKEN) {
    return res.status(401).json({ ok: false });
  }
  res.cookie("tn_admin", ADMIN_TOKEN, {
    httpOnly: true, sameSite: "lax", maxAge: 1000 * 60 * 60 * 12, path: "/",
  });
  res.json({ ok: true });
});
app.post("/api/auth/logout", (_req, res) => {
  res.clearCookie("tn_admin", { path: "/" });
  res.json({ ok: true });
});
app.get("/api/auth/me", (req, res) => res.json({ authed: authed(req), publicUrl: PUBLIC_URL }));

// ---- Build / deploy diagnostics ----
app.get("/api/version", requireAuth, (_req, res) => {
  res.json({
    version: APP_VERSION,
    exporterVersion: process.env.EXPORTER_VERSION || APP_VERSION,
    configuredAppVersion: process.env.APP_VERSION || null,
    buildTime: process.env.BUILD_TIME || null,
    gitSha: process.env.GIT_SHA || null,
    nodeEnv: process.env.NODE_ENV || null,
  });
});

app.get("/api/health", requireAuth, (_req, res) => {
  res.json({
    ok: true,
    app: "telenova-wa-archive",
    version: APP_VERSION,
    configuredAppVersion: process.env.APP_VERSION || null,
    buildTime: process.env.BUILD_TIME || null,
    gitSha: process.env.GIT_SHA || null,
    uptime: process.uptime(),
    exportDir: EXPORT_DIR,
    sessionDir: SESSION_DIR,
    tmpDir: TMP_DIR,
  });
});

// ---- Export endpoints ----
app.get("/api/export", requireAuth, (_req, res) => {
  const rawJobs = manager.list();
  const jobs = rawJobs.map(publicRecord);
  const represented = new Set(rawJobs.flatMap((record) => [record.id, record.zipFileName || ""]));
  const files = listZipFiles()
    .filter((zip) => !represented.has(zip.id) && !represented.has(zip.zipFileName))
    .map((zip) => ({
      id: zip.id,
      status: "file_available",
      zipFileName: zip.zipFileName,
      size: zip.size,
      createdAt: zip.createdAt,
      progress: { chatsFound: 0, chatsImported: 0, messagesImported: 0, mediaDownloaded: 0, mediaFailed: 0, errors: 0, elapsedMs: 0 },
      options: { companyName: companyFromZipName(zip.zipFileName, zip.id), phoneNumber: "", responsibleName: "" },
    }));
  res.json({ exports: [...jobs, ...files].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
});

app.post("/api/export/start", requireAuth, upload.single("contacts"), (req, res) => {
  let contactFilePath: string | undefined;
  try {
    const raw = typeof req.body?.options === "string" ? JSON.parse(req.body.options) : req.body;
    const o = raw as ExportOptions;
    if (!o?.companyName || !o?.phoneNumber || !o?.responsibleName) {
      if (req.file?.path) fs.rmSync(req.file.path, { force: true });
      return res.status(400).json({ error: "campos obrigatórios faltando" });
    }
    const active = manager.list().filter((r) =>
      ["created","connecting","qr_ready","authenticated","listing_chats","importing_messages","downloading_media","building_index","building_viewer","zipping"].includes(r.status)
    ).length;
    if (active >= MAX_CONCURRENT) {
      if (req.file?.path) fs.rmSync(req.file.path, { force: true });
      return res.status(429).json({
        error: "concurrency_limit",
        message: `Já existe ${active} exportação ativa. Aguarde finalizar ou aumente MAX_CONCURRENT_EXPORTS.`,
      });
    }
    if (req.file) {
      const ext = path.extname(req.file.originalname).toLowerCase();
      contactFilePath = path.join(TMP_DIR, `contacts-${crypto.randomUUID()}${ext}`);
      fs.renameSync(req.file.path, contactFilePath);
      o.contactFilePath = contactFilePath;
      o.contactFileName = path.basename(req.file.originalname);
    }
    // cria e dispara em background — não aguarda job.start()
    const job = manager.createAndStart(o);
    res.json({ id: job.record.id });
  } catch (e) {
    if (req.file?.path && fs.existsSync(req.file.path)) fs.rmSync(req.file.path, { force: true });
    if (contactFilePath && fs.existsSync(contactFilePath)) fs.rmSync(contactFilePath, { force: true });
    res.status(500).json({ error: (e as Error).message });
  }
});

app.get("/api/export/:id/qr", requireAuth, (req, res) => {
  const j = manager.get(req.params.id);
  if (!j) return res.status(404).json({ error: "not_found" });
  res.json({ qr: j.record.qrDataUrl || null, status: j.record.status });
});

app.get("/api/export/:id/status", requireAuth, (req, res) => {
  const j = manager.get(req.params.id);
  if (!j) {
    const zip = findZipByExportId(req.params.id);
    if (!zip) return res.status(404).json({ error: "not_found" });
    return res.json(fileStatus(zip));
  }
  const r = j.record;
  res.json({
    id: r.id, status: r.status, progress: r.progress, error: r.errorMessage,
    zipFileName: r.zipFileName, qr: r.qrDataUrl || null,
    options: publicOptions(r.options), createdAt: r.createdAt,
    logs: r.logs.slice(-200),
  });
});

app.get("/api/export/:id/file-status", requireAuth, (req, res) => {
  const zip = findZipByExportId(req.params.id);
  if (!zip) return res.status(404).json({ error: "not_found" });
  res.json(fileStatus(zip));
});

app.post("/api/export/:id/cancel", requireAuth, (req, res) => {
  const j = manager.get(req.params.id);
  if (!j) return res.status(404).json({ error: "not_found" });
  j.cancel();
  res.json({ ok: true });
});

app.post("/api/export/:id/retry", requireAuth, async (req, res) => {
  const j = manager.get(req.params.id);
  if (!j) return res.status(404).json({ error: "not_found" });

  try {
    await j.retryImport();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.get("/api/export/:id/download", requireAuth, (req, res) => {
  const j = manager.get(req.params.id);
  const record = j?.record;
  let zipPath = record?.zipPath;
  let zipFileName = record?.zipFileName;
  if (zipPath && !fs.existsSync(zipPath)) zipPath = undefined;
  if (!zipPath && zipFileName) {
    const candidate = path.join(EXPORT_DIR, path.basename(zipFileName));
    if (fs.existsSync(candidate)) zipPath = candidate;
  }
  if (!zipPath) {
    const physical = findZipByExportId(req.params.id);
    zipPath = physical?.zipPath;
    zipFileName = physical?.zipFileName;
  }
  if (!zipPath || !zipFileName) {
    return res.status(404).json({ error: "zip_file_missing", id: req.params.id, exportDir: EXPORT_DIR });
  }
  res.download(zipPath, zipFileName, (err) => {
    if (err) console.error("download failed", { id: req.params.id, zipPath, zipFileName, err });
  });
});

app.post("/api/export/:id/disconnect", requireAuth, async (req, res) => {
  const j = manager.get(req.params.id);
  if (!j) return res.status(404).json({ error: "not_found" });
  await j.stopAndDisconnect();
  res.json({ ok: true });
});

app.delete("/api/export/:id/cleanup", requireAuth, async (req, res) => {
  await manager.remove(req.params.id);
  res.json({ ok: true });
});

// ---- Admin UI estática ----
const ADMIN_DIR = path.join(__dirname, "admin");
// Arquivos liberados sem autenticação (para a própria tela de login funcionar)
const PUBLIC_FILES = new Set(["/login.html", "/style.css", "/favicon.ico"]);
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  if (PUBLIC_FILES.has(req.path) || req.path.startsWith("/assets/")) return next();
  if (!authed(req)) return res.redirect("/login.html");
  next();
});
app.use(express.static(ADMIN_DIR, { extensions: ["html"] }));

app.listen(PORT, () => {
  console.log(`Telenova WA Archive v${APP_VERSION} online em :${PORT} (público: ${PUBLIC_URL})`);
  console.log(`Concorrência máxima: ${MAX_CONCURRENT} exportação(ões) simultânea(s).`);
});
