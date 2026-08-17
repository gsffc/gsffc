#!/usr/bin/env node
// Enforces the media asset policy from AGENTS.md hard rule 1:
//   - no GIFs anywhere
//   - WebM: max width 640 px, <= 2 MB
//   - JPG:  max dimension 1600 px, <= 400 KB
//   - PNG:  <= 400 KB (proxy for "graphics only"; photographic PNGs are bigger)
//   - <= ~10 MB total media referenced by any single post
// Requires ffprobe (from ffmpeg) for dimension checks.
// Usage: npm run check:assets

import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const SKIP_DIRS = new Set([".git", "node_modules", "_site", ".cache"]);

const LIMITS = {
  webmBytes: 2 * 1024 * 1024,
  webmWidth: 640,
  jpgBytes: 400 * 1024,
  jpgMaxDim: 1600,
  pngBytes: 400 * 1024,
  postMediaBytes: 10 * 1024 * 1024,
};

const violations = [];
const warnings = [];
const fail = (file, msg) => violations.push(`${relative(ROOT, file)}: ${msg}`);
const warn = (file, msg) => warnings.push(`${relative(ROOT, file)}: ${msg}`);

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

async function probeSize(file) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "csv=p=0",
    file,
  ]);
  const [w, h] = stdout.trim().split(",").map(Number);
  return { width: w || 0, height: h || 0 };
}

// Run ffprobe with bounded concurrency.
async function mapPool(items, size, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, worker),
  );
  return results;
}

async function checkFile(file) {
  const lower = file.toLowerCase();
  const bytes = (await stat(file)).size;
  if (lower.endsWith(".gif")) {
    fail(file, "GIFs are not allowed; convert to WebM (npm run convert:media)");
  } else if (lower.endsWith(".webm")) {
    if (bytes > LIMITS.webmBytes)
      fail(file, `WebM ${(bytes / 1048576).toFixed(1)} MB > 2 MB`);
    const { width } = await probeSize(file);
    if (width > LIMITS.webmWidth) fail(file, `WebM width ${width}px > 640px`);
  } else if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    if (bytes > LIMITS.jpgBytes)
      fail(file, `JPG ${(bytes / 1024).toFixed(0)} KB > 400 KB`);
    const { width, height } = await probeSize(file);
    if (Math.max(width, height) > LIMITS.jpgMaxDim)
      fail(file, `JPG ${width}x${height} exceeds 1600px max dimension`);
  } else if (lower.endsWith(".png")) {
    if (bytes > LIMITS.pngBytes)
      fail(
        file,
        `PNG ${(bytes / 1024).toFixed(0)} KB > 400 KB (PNG is for graphics only)`,
      );
  }
}

// Sum the media bytes referenced by each post; flag posts over ~10 MB.
async function checkPosts() {
  const postsDir = join(ROOT, "site", "_posts");
  let postFiles = [];
  try {
    postFiles = (await readdir(postsDir)).filter((f) => f.endsWith(".md"));
  } catch {
    return; // site/ not populated yet (pre-#3)
  }
  for (const postFile of postFiles) {
    const text = await readFile(join(postsDir, postFile), "utf8");
    const refs = text.match(/\/assets\/[^\s"')>\]]+/g) ?? [];
    let total = 0;
    for (const ref of new Set(refs)) {
      try {
        total += (await stat(join(ROOT, "site", ref))).size;
      } catch {
        // Dangling refs are the import/link checker's job, not the policy's.
      }
    }
    if (total > LIMITS.postMediaBytes)
      // Per-post total is a soft ("~") limit in AGENTS.md — warn, don't fail.
      warn(
        join(postsDir, postFile),
        `post references ${(total / 1048576).toFixed(1)} MB of media > ~10 MB; consider hosting externally and linking`,
      );
  }
}

async function ffprobeAvailable() {
  try {
    await execFileAsync("ffprobe", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

if (!(await ffprobeAvailable())) {
  console.error(
    "ffprobe not found. Install ffmpeg (apt install ffmpeg / brew install ffmpeg).",
  );
  process.exit(2);
}

const files = [];
for await (const f of walk(ROOT)) files.push(f);
const media = files.filter((f) => /\.(gif|webm|jpe?g|png)$/i.test(f));

await mapPool(media, 8, checkFile);
await checkPosts();

if (warnings.length > 0) {
  console.log(`Asset policy warnings (${warnings.length}):`);
  for (const w of warnings) console.log(`  ${w}`);
}
if (violations.length > 0) {
  console.error(`Asset policy violations (${violations.length}):`);
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log(`Asset policy OK — ${media.length} media files checked.`);
