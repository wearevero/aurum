import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface EnvLoadResult {
  path: string | null;
  loaded: number;
}

/** Decode UTF-8 / UTF-8 BOM / UTF-16 (PowerShell `>` menghasilkan UTF-16). */
function decode(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe)
    return buf.subarray(2).toString("utf16le");
  if (buf[0] === 0xfe && buf[1] === 0xff)
    return Buffer.from(buf.subarray(2)).swap16().toString("utf16le");
  const s = buf.toString("utf8");
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2];
    if (v.startsWith('"') || v.startsWith("'")) {
      const end = v.indexOf(v[0], 1);
      v = end > 0 ? v.slice(1, end) : v.slice(1);
    } else {
      v = v.replace(/\s+#.*$/, "").trim(); // komentar inline
    }
    out[m[1]] = v;
  }
  return out;
}

/** Variabel yang sudah terisi tidak ditimpa; yang ada tapi KOSONG ditimpa nilai file. */
export function loadEnv(candidates?: string[]): EnvLoadResult {
  const here = dirname(fileURLToPath(import.meta.url));
  const paths = candidates ?? [
    resolve(process.cwd(), ".env"),
    resolve(here, "..", ".env"),
  ];
  const path = paths.find((p) => existsSync(p)) ?? null;
  if (!path) return { path: null, loaded: 0 };
  let loaded = 0;
  for (const [k, v] of Object.entries(parseEnv(decode(readFileSync(path))))) {
    if (process.env[k] === undefined || process.env[k] === "") {
      process.env[k] = v;
      loaded++;
    }
  }
  return { path, loaded };
}
