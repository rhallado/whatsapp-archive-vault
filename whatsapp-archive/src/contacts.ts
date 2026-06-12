import fsp from "node:fs/promises";
import path from "node:path";

export type ContactDirectory = Map<string, string>;

export function normalizePhone(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"' && quoted && line[i + 1] === '"') { value += '"'; i += 1; }
    else if (char === '"') quoted = !quoted;
    else if ((char === "," || char === ";") && !quoted) { values.push(value.trim()); value = ""; }
    else value += char;
  }
  values.push(value.trim());
  return values;
}

function parseCsv(content: string): ContactDirectory {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  const result: ContactDirectory = new Map();
  if (lines.length < 2) return result;
  const headers = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const nameKeys = ["name", "nome", "fullname"];
  const phoneKeys = ["phone", "telefone", "number", "numero"];
  const nameIndex = headers.findIndex((h) => nameKeys.includes(h));
  const phoneIndex = headers.findIndex((h) => phoneKeys.includes(h));
  if (nameIndex < 0 || phoneIndex < 0) return result;
  for (const line of lines.slice(1)) {
    const row = parseCsvLine(line);
    const phone = normalizePhone(row[phoneIndex]);
    const name = row[nameIndex]?.trim();
    if (phone && name) result.set(phone, name);
  }
  return result;
}

function parseVcf(content: string): ContactDirectory {
  const result: ContactDirectory = new Map();
  const unfolded = content.replace(/\r?\n[ \t]/g, "");
  for (const card of unfolded.split(/END:VCARD/i)) {
    const name = card.match(/^FN(?:;[^:]*)?:(.*)$/im)?.[1]?.trim();
    if (!name) continue;
    for (const match of card.matchAll(/^TEL(?:;[^:]*)?:(.*)$/gim)) {
      const phone = normalizePhone(match[1]);
      if (phone) result.set(phone, name);
    }
  }
  return result;
}

export async function loadContactDirectory(filePath?: string): Promise<ContactDirectory> {
  if (!filePath) return new Map();
  const content = await fsp.readFile(filePath, "utf8");
  return path.extname(filePath).toLowerCase() === ".vcf" ? parseVcf(content) : parseCsv(content);
}

export function findContactName(directory: ContactDirectory, phone: string): string | undefined {
  const normalized = normalizePhone(phone);
  if (!normalized) return undefined;
  const exact = directory.get(normalized);
  if (exact) return exact;
  if (normalized.length < 10) return undefined;
  for (const [candidate, name] of directory) {
    if (candidate.length >= 10 && (candidate.endsWith(normalized) || normalized.endsWith(candidate))) return name;
  }
  return undefined;
}