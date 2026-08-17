#!/usr/bin/env node
// GSF-centric filter for site/_data/seasons (issue #3). Run once at import
// time; committed so the rules stay auditable and rerunnable.
//
// Keep rules:
//   1. GSF-internal events (season key matches weeklycup/juggle, or
//      config.team_info/display_name says GSF) — keep the season wholly.
//   2. Otherwise keep a game if home.key or away.key mentions "GSF".
//   3. For cups GSF contested (a knockout bracket containing a GSF team),
//      also keep every game referenced by that bracket (the knockout path).
//   4. Keep team entries = GSF squads + opponents appearing in kept games.
// Season config.json is kept verbatim; presentation-level rescoping is the
// renderer's job (#5).
//
// Usage:
//   node scripts/filter-season-data.mjs [--dry-run] [seasonsDir]
// Default seasonsDir: site/_data/seasons. Prints keep/drop counts per season.

import { readdir, readFile, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const seasonsDir = resolve(args.find((a) => !a.startsWith("--")) ?? "site/_data/seasons");

const isGsf = (key) => typeof key === "string" && key.includes("GSF");

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function listJson(dir) {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
}

function isInternalEvent(seasonKey, config) {
  if (/weeklycup|juggle/i.test(seasonKey)) return true;
  if (isGsf(config.team_info ?? "")) return true;
  return false;
}

// Game ids referenced by any knockout bracket containing a GSF team.
function gsfKnockoutGameIds(config) {
  const ids = new Set();
  for (const knockout of Object.values(config.knockouts ?? {})) {
    const flat = JSON.stringify(knockout.bracket ?? []);
    if (!flat.includes("GSF")) continue;
    for (const round of knockout.bracket ?? []) {
      for (const tie of round) {
        const gameId = Array.isArray(tie) ? tie[2] : null;
        if (typeof gameId === "string") ids.add(`${gameId}.json`);
      }
    }
  }
  return ids;
}

let totalKept = 0;
let totalDropped = 0;

for (const season of (await readdir(seasonsDir)).sort()) {
  const dir = join(seasonsDir, season);
  const config = await readJson(join(dir, "config.json"));
  const internal = isInternalEvent(season, config);

  const gamesDir = join(dir, "games");
  const gameFiles = await listJson(gamesDir);
  const knockoutIds = gsfKnockoutGameIds(config);

  const keptTeams = new Set();
  let kept = 0;
  let dropped = 0;

  for (const file of gameFiles) {
    const path = join(gamesDir, file);
    const game = await readJson(path);
    const keep =
      internal ||
      isGsf(game.home?.key) ||
      isGsf(game.away?.key) ||
      knockoutIds.has(file);
    if (keep) {
      kept++;
      for (const side of ["home", "away"]) {
        if (game[side]?.key) keptTeams.add(game[side].key);
      }
    } else {
      dropped++;
      if (!dryRun) await rm(path);
    }
  }

  // Team entries: GSF squads + opponents appearing in kept games.
  const teamsDir = join(dir, "teams");
  let teamsKept = 0;
  let teamsDropped = 0;
  for (const file of await listJson(teamsDir)) {
    const key = basename(file, ".json");
    if (internal || isGsf(key) || keptTeams.has(key)) {
      teamsKept++;
    } else {
      teamsDropped++;
      if (!dryRun) await rm(join(teamsDir, file));
    }
  }

  totalKept += kept;
  totalDropped += dropped;
  const tag = internal ? " [GSF-internal: kept wholly]" : "";
  console.log(
    `${season}: games kept ${kept}, dropped ${dropped}; teams kept ${teamsKept}, dropped ${teamsDropped}${tag}`,
  );
}

console.log(
  `\nTOTAL: games kept ${totalKept}, dropped ${totalDropped}${dryRun ? " (dry run — no files removed)" : ""}`,
);
