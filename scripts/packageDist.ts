/**
 * Bundle compiled server binaries into ready-to-ship zip archives.
 *
 * Each zip contains a top-level `doors/` folder:
 *   doors/
 *     doors-server[.exe]
 *     config.json
 *     TERMS.md
 *     README.md           (run instructions; source is scripts/download-readme.md)
 *     maps/*.doors.json   (competitive pool only; raid and campaign maps never ship)
 *
 * Usage (from server/):
 *   deno task package
 *   deno run -A scripts/packageDist.ts
 */

/** server/ package root (parent of scripts/). */
const ROOT = new URL("..", import.meta.url);
const DIST = new URL("dist/", ROOT);
const MAP_POOLS = [
  new URL("maps/competitive/", ROOT),
];
const CONFIG = new URL("config.json", ROOT);
const TERMS = new URL("TERMS.md", ROOT);
const DOWNLOAD_README = new URL("scripts/download-readme.md", ROOT);
/** game/client/public/downloads/ — one level up from server/, then into client. */
const CLIENT_DOWNLOADS = new URL("../client/public/downloads/", ROOT);
const STAGING = new URL("dist/.package-staging/", ROOT);

type PlatformBundle = {
  /** Binary filename produced by `deno task compile:*`. */
  binaryName: string;
  /** Filename of the binary inside the doors/ folder. */
  packagedBinaryName: string;
  /** Zip basename without .zip (e.g. doors-server-mac-arm64). */
  zipBaseName: string;
  label: string;
};

/** Cross-compile targets from `deno task compile:*` (preferred when present). */
const CROSS_BUNDLES: PlatformBundle[] = [
  {
    binaryName: "doors-server-mac-arm64",
    packagedBinaryName: "doors-server",
    zipBaseName: "doors-server-mac-arm64",
    label: "macOS Apple Silicon",
  },
  {
    binaryName: "doors-server-mac-x64",
    packagedBinaryName: "doors-server",
    zipBaseName: "doors-server-mac-x64",
    label: "macOS Intel",
  },
  {
    binaryName: "doors-server-win.exe",
    packagedBinaryName: "doors-server.exe",
    zipBaseName: "doors-server-win",
    label: "Windows",
  },
  {
    binaryName: "doors-server-linux",
    packagedBinaryName: "doors-server",
    zipBaseName: "doors-server-linux",
    label: "Linux x64",
  },
];

/** Host binary from plain `deno task compile` → same zip names by OS/arch. */
function hostLocalBundle(): PlatformBundle | null {
  const { os, arch } = Deno.build;
  if (os === "darwin" && arch === "aarch64") {
    return {
      binaryName: "doors-server",
      packagedBinaryName: "doors-server",
      zipBaseName: "doors-server-mac-arm64",
      label: "macOS Apple Silicon (host)",
    };
  }
  if (os === "darwin" && arch === "x86_64") {
    return {
      binaryName: "doors-server",
      packagedBinaryName: "doors-server",
      zipBaseName: "doors-server-mac-x64",
      label: "macOS Intel (host)",
    };
  }
  if (os === "windows") {
    return {
      binaryName: "doors-server",
      packagedBinaryName: "doors-server.exe",
      zipBaseName: "doors-server-win",
      label: "Windows (host)",
    };
  }
  if (os === "linux") {
    return {
      binaryName: "doors-server",
      packagedBinaryName: "doors-server",
      zipBaseName: "doors-server-linux",
      label: "Linux (host)",
    };
  }
  return null;
}

function pathFromUrl(url: URL): string {
  return Deno.build.os === "windows"
    ? decodeURIComponent(url.pathname.replace(/^\//, ""))
    : decodeURIComponent(url.pathname);
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function rmrf(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}

async function ensureDir(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true });
}

function shouldSkipEntry(name: string): boolean {
  return name === ".DS_Store" || name.startsWith("._") || name === "Thumbs.db";
}

/** Copy one pool's .doors.json files flat into the downloadable maps folder. */
async function copyMapPool(srcDir: string, destDir: string): Promise<void> {
  for await (const entry of Deno.readDir(srcDir)) {
    if (!entry.isFile || !entry.name.endsWith(".doors.json")) continue;
    if (shouldSkipEntry(entry.name)) continue;
    await Deno.copyFile(`${srcDir}/${entry.name}`, `${destDir}/${entry.name}`);
  }
}

async function chmodExecutable(path: string): Promise<void> {
  if (Deno.build.os === "windows") return;
  try {
    await Deno.chmod(path, 0o755);
  } catch {
    // Best-effort.
  }
}

/** Create zip with a top-level `doors/` entry using the system zip CLI. */
async function zipDoorsFolder(
  stagingParent: string,
  zipPath: string,
): Promise<void> {
  await rmrf(zipPath);
  const cmd = new Deno.Command("zip", {
    args: ["-r", "-q", zipPath, "doors"],
    cwd: stagingParent,
    stdout: "piped",
    stderr: "piped",
  });
  const result = await cmd.output();
  if (!result.success) {
    const err = new TextDecoder().decode(result.stderr);
    throw new Error(`zip failed for ${zipPath}: ${err || "unknown error"}`);
  }
}

async function packageBundle(bundle: PlatformBundle): Promise<string | null> {
  const distPath = pathFromUrl(DIST);
  const binaryPath = `${distPath}/${bundle.binaryName}`;
  if (!(await exists(binaryPath))) {
    return null;
  }

  const packageStaging = `${pathFromUrl(STAGING)}/${bundle.zipBaseName}`;
  const doorsDir = `${packageStaging}/doors`;
  const mapsDest = `${doorsDir}/maps`;

  await rmrf(packageStaging);
  await ensureDir(doorsDir);
  await ensureDir(mapsDest);

  const packagedBinary = `${doorsDir}/${bundle.packagedBinaryName}`;
  await Deno.copyFile(binaryPath, packagedBinary);
  await chmodExecutable(packagedBinary);

  await Deno.copyFile(pathFromUrl(CONFIG), `${doorsDir}/config.json`);
  await Deno.copyFile(pathFromUrl(TERMS), `${doorsDir}/TERMS.md`);
  await Deno.copyFile(pathFromUrl(DOWNLOAD_README), `${doorsDir}/README.md`);
  for (const pool of MAP_POOLS) {
    await copyMapPool(pathFromUrl(pool), mapsDest);
  }

  const zipPath = `${distPath}/${bundle.zipBaseName}.zip`;
  await zipDoorsFolder(packageStaging, zipPath);
  await rmrf(packageStaging);
  return zipPath;
}

async function main(): Promise<void> {
  const distPath = pathFromUrl(DIST);
  if (!(await exists(distPath))) {
    console.error("No dist/ folder. Run a compile task first, e.g.:");
    console.error("  deno task compile:all");
    Deno.exit(1);
  }

  if (!(await exists(pathFromUrl(CONFIG)))) {
    console.error("Missing config.json next to the server package.");
    Deno.exit(1);
  }
  for (const pool of MAP_POOLS) {
    if (!(await exists(pathFromUrl(pool)))) {
      console.error(`Missing map pool: ${pool.pathname}`);
      Deno.exit(1);
    }
  }

  // Cross-compile targets first; host binary only fills missing zip slots.
  const candidates = [...CROSS_BUNDLES];
  const host = hostLocalBundle();
  if (host) candidates.push(host);

  console.log("Packaging server distributions…");
  const producedByZip = new Map<string, string>();

  for (const bundle of candidates) {
    if (producedByZip.has(bundle.zipBaseName)) continue;

    try {
      const zip = await packageBundle(bundle);
      if (!zip) continue;
      producedByZip.set(bundle.zipBaseName, zip);
      console.log(`  ✓ ${bundle.label}: ${zip.split(/[/\\]/).pop()}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ ${bundle.label}: ${message}`);
      Deno.exit(1);
    }
  }

  await rmrf(pathFromUrl(STAGING));

  const produced = [...producedByZip.values()];
  if (produced.length === 0) {
    console.error("No binaries found in dist/. Compile first:");
    console.error("  deno task compile");
    console.error("  deno task compile:all");
    Deno.exit(1);
  }

  const downloadsPath = pathFromUrl(CLIENT_DOWNLOADS);
  await ensureDir(downloadsPath);
  for (const zip of produced) {
    const name = zip.split(/[/\\]/).pop()!;
    await Deno.copyFile(zip, `${downloadsPath}/${name}`);
  }
  console.log(`Copied ${produced.length} zip(s) → client/public/downloads/`);
  console.log(
    "Note: for production, upload server/dist/*.zip to R2 (or your CDN). " +
      "Cloudflare Pages Free rejects files over 25 MiB — do not ship zips in the Pages artifact.",
  );
  console.log("Done.");
}

if (import.meta.main) {
  await main();
}
