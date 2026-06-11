import express, { type Request, type Response, type NextFunction } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import { ExportManager } from "./exporter";
import type { ExportOptions } from "./types";

const PORT = parseInt(process.env.PORT || "3000", 10);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const SESSION_DIR = process.env.SESSION_DIR || "/data/sessions";
const EXPORT_DIR = process.env.EXPORT_DIR || "/data/exports";
const TMP_DIR = process.env.TMP_DIR || "/data/tmp";

if (!ADMIN_TOKEN || ADMIN_TOKEN.length < 12) {
  console.error("ADMIN_TOKEN ausente ou muito curto (mínimo 12 chars). Abortando.");
  process.exit(1);
}

for (const d of [SESSION_DIR, EXPORT_DIR, TMP_DIR]) fs.mkdirSync(d, { recursive: true });

const manager = new ExportManager({ tmp: TMP_DIR, sessions: SESSION_DIR, exports: EXPORT_DIR });

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

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

// ---- Export endpoints ----
app.get("/api/export", requireAuth, (_req, res) => {
  res.json({ exports: manager.list() });
});

app.post("/api/export/start", requireAuth, async (req, res) => {
  try {
    const o = req.body as ExportOptions;
    if (!o?.companyName || !o?.phoneNumber || !o?.responsibleName) {
      return res.status(400).json({ error: "campos obrigatórios faltando" });
    }
    const job = await manager.create(o);
    res.json({ id: job.record.id });
  } catch (e) {
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
  if (!j) return res.status(404).json({ error: "not_found" });
  const r = j.record;
  res.json({
    id: r.id, status: r.status, progress: r.progress, error: r.errorMessage,
    zipFileName: r.zipFileName, qr: r.qrDataUrl || null,
    options: r.options, createdAt: r.createdAt,
    logs: r.logs.slice(-200),
  });
});

app.post("/api/export/:id/cancel", requireAuth, (req, res) => {
  const j = manager.get(req.params.id);
  if (!j) return res.status(404).json({ error: "not_found" });
  j.cancel();
  res.json({ ok: true });
});

app.get("/api/export/:id/download", requireAuth, (req, res) => {
  const j = manager.get(req.params.id);
  if (!j?.record.zipPath) return res.status(404).json({ error: "zip_not_ready" });
  res.download(j.record.zipPath, j.record.zipFileName!);
});

app.post("/api/export/:id/disconnect", requireAuth, async (req, res) => {
  const j = manager.get(req.params.id);
  if (!j) return res.status(404).json({ error: "not_found" });
  await j.disconnect();
  res.json({ ok: true });
});

app.delete("/api/export/:id/cleanup", requireAuth, async (req, res) => {
  await manager.remove(req.params.id);
  res.json({ ok: true });
});

// ---- Admin UI estática ----
const ADMIN_DIR = path.join(__dirname, "admin");
app.use("/", (req, res, next) => {
  // gate simples: tudo que não é /login.html nem /api requer cookie
  if (req.path.startsWith("/api/")) return next();
  if (req.path === "/login.html" || req.path.startsWith("/assets/") || req.path === "/favicon.ico") return next();
  if (!authed(req)) return res.redirect("/login.html");
  next();
});
app.use(express.static(ADMIN_DIR, { extensions: ["html"] }));

app.listen(PORT, () => {
  console.log(`Telenova WA Archive online em :${PORT} (público: ${PUBLIC_URL})`);
});
