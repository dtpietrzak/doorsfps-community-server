/**
 * Fail when this package imports any file outside itself. In the private
 * monorepo that is the official bot engine, repo-root `shared/`, the client,
 * server-authority, and the rest: they import this package, never the
 * reverse (D10). `shared/` here is inside the package, so `../shared/...`
 * from a nested file stays allowed.
 *
 * Import and export specifiers are checked, and so is the deno.json import
 * map, so an alias cannot point outside either.
 */

const ROOT_SHARED = "root shared";
const OUTSIDE = "a file outside server-community";

const PACKAGE_ROOT = new URL("..", import.meta.url);
const SKIP_DIRS = new Set(["node_modules", "dist", "graphify-out", ".deno"]);
const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".jsx"]);

const FROM_SPEC = /(?:import|export)\b[\s\S]*?\bfrom\s*["']([^"']+)["']/g;
const SIDE_SPEC = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;
const DYNAMIC_SPEC = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

type Hit = { file: string; line: number; specifier: string; banned: string };

const PACKAGE_PATH = decodeURIComponent(PACKAGE_ROOT.pathname);
const ROOT_SHARED_PATH = decodeURIComponent(
  new URL("../../shared/", import.meta.url).pathname,
);

/** Relative specifier that resolves outside this package, or null. */
function leavesPackage(from: URL, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  let resolved: URL;
  try {
    resolved = new URL(specifier, from);
  } catch {
    return null;
  }
  const path = decodeURIComponent(resolved.pathname);
  if (path.startsWith(PACKAGE_PATH)) return null;
  const inRootShared = path === ROOT_SHARED_PATH.replace(/\/$/, "") ||
    path.startsWith(ROOT_SHARED_PATH);
  return inRootShared ? ROOT_SHARED : OUTSIDE;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function scanSource(
  fileUrl: URL,
  rel: string,
  text: string,
  hits: Hit[],
): void {
  for (const re of [FROM_SPEC, SIDE_SPEC, DYNAMIC_SPEC]) {
    re.lastIndex = 0;
    for (const match of text.matchAll(re)) {
      const specifier = match[1] ?? "";
      const banned = leavesPackage(fileUrl, specifier);
      if (!banned || match.index === undefined) continue;
      hits.push({
        file: rel,
        // The `from` pattern can start at an earlier `import`; count to the specifier.
        line: lineOf(text, match.index + match[0].lastIndexOf(specifier)),
        specifier,
        banned,
      });
    }
  }
}

async function walk(dir: URL, hits: Hit[]): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const url = new URL(`${entry.name}${entry.isDirectory ? "/" : ""}`, dir);
    if (entry.isDirectory) {
      await walk(url, hits);
      continue;
    }
    const ext = entry.name.slice(entry.name.lastIndexOf("."));
    if (!SOURCE_EXT.has(ext)) continue;
    const text = await Deno.readTextFile(url);
    const rel = url.pathname.slice(PACKAGE_ROOT.pathname.length);
    scanSource(url, rel, text, hits);
  }
}

function scanImportMap(hits: Hit[]): void {
  const path = new URL("./deno.json", PACKAGE_ROOT);
  const json = JSON.parse(Deno.readTextFileSync(path)) as {
    imports?: Record<string, string>;
  };
  const imports = json.imports ?? {};
  for (const [key, value] of Object.entries(imports)) {
    const banned = leavesPackage(path, value);
    if (!banned) continue;
    hits.push({
      file: "deno.json",
      line: 1,
      specifier: `${key} -> ${value}`,
      banned,
    });
  }
}

const hits: Hit[] = [];
scanImportMap(hits);
await walk(PACKAGE_ROOT, hits);

if (hits.length === 0) {
  console.log(
    "server-community imports no file outside the package",
  );
  Deno.exit(0);
}

for (const hit of hits) {
  console.error(
    `${hit.file}:${hit.line}: import reaches ${hit.banned} (${hit.specifier})`,
  );
}
Deno.exit(1);
