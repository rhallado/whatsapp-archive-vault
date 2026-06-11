// Copia assets estáticos (admin UI + template do viewer) para dist/ após o build TS.
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

async function copyDir(rel) {
  const src = path.join(root, "src", rel);
  const dst = path.join(root, "dist", rel);
  await mkdir(dst, { recursive: true });
  await cp(src, dst, { recursive: true });
  console.log(`copied src/${rel} -> dist/${rel}`);
}

await copyDir("admin");
await copyDir("viewer");
