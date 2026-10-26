/**
 * Load laptop env from env-vars/.env.development or env-vars/.env.prod.
 *
 * If those files are missing (EC2 checkout), fall back to ./ .env in cwd.
 * Existing process env is never overwritten.
 *
 * Import for side effect from process entrypoints. The module lives at
 * `server-community/shared/env/loadRepoEnv.ts`.
 */
import { parse } from "jsr:@std/dotenv@0.225.2";
import { dirname, fromFileUrl, join } from "jsr:@std/path@1";

export type LoadRepoEnvResult = {
  path: string | null;
  source: "env-vars" | "fallback" | "none";
};

function exists(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

function existsDir(path: string): boolean {
  try {
    return Deno.statSync(path).isDirectory;
  } catch {
    return false;
  }
}

function walkForRepoRoot(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    if (existsDir(join(dir, "env-vars"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function findRepoRoot(): string | null {
  const starts: string[] = [Deno.cwd()];
  try {
    starts.push(fromFileUrl(new URL("../..", import.meta.url)));
  } catch {
    // compiled binary / odd URL
  }
  for (const start of starts) {
    const root = walkForRepoRoot(start);
    if (root) return root;
  }
  return null;
}

export function envFileName(doorsEnv = Deno.env.get("DOORS_ENV")): string {
  const raw = (doorsEnv ?? "development").trim().toLowerCase();
  if (raw === "prod" || raw === "production") return ".env.prod";
  return ".env.development";
}

function applyParsed(text: string): void {
  const record = parse(text);
  for (const [key, value] of Object.entries(record)) {
    if (Deno.env.get(key) === undefined) {
      Deno.env.set(key, value);
    }
  }
}

/** Apply one dotenv file. Does not override keys already set. */
export function applyEnvFile(path: string): boolean {
  if (!exists(path)) return false;
  applyParsed(Deno.readTextFileSync(path));
  return true;
}

/** Load the unified file (or cwd .env). Safe to call more than once. */
export function loadRepoEnv(
  fallback = join(Deno.cwd(), ".env"),
): LoadRepoEnvResult {
  const root = findRepoRoot();
  if (root) {
    const unified = join(root, "env-vars", envFileName());
    if (exists(unified)) {
      applyParsed(Deno.readTextFileSync(unified));
      return { path: unified, source: "env-vars" };
    }
  }
  if (exists(fallback)) {
    applyParsed(Deno.readTextFileSync(fallback));
    return { path: fallback, source: "fallback" };
  }
  return { path: null, source: "none" };
}

loadRepoEnv();
