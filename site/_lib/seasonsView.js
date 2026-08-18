// Builds the GSF-centric season view models from _data/seasons/**/*.json
// (auto-loaded by Eleventy as global `seasons`; loaded here directly so
// templates, pagination, and filters all share one enriched model).
//
// Port of the parts of the old Jekyll league_generator.rb that GSF-centric
// pages need: team enrichment onto games, per-season stat aggregations
// (goal scorers / assists), weekly-cup league table, knockout brackets for
// cups GSF contested, juggle-contest groups, team history stats. League-wide
// standings are deliberately not computed — nccsf.org is linked out instead.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SEASONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "_data",
  "seasons",
);

const isGsf = (key) => typeof key === "string" && key.includes("GSF");

// Jekyll-style URL sanitization observed on the live site:
// "2025-11-09 20:00-PKU-PPUnited" -> "2025-11-09_2000-PKU-PPUnited".
export const gameSlug = (key) => key.replace(/\s+/g, "_").replace(/:/g, "");

const norm = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function listJson(dir) {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
}

function isInternalEvent(seasonKey, config) {
  return /weeklycup|juggle/i.test(seasonKey) || isGsf(config.team_info ?? "");
}

function blankStats() {
  return {
    games_played: 0,
    wins: 0,
    draws: 0,
    loses: 0,
    goals_for: 0,
    goals_against: 0,
    goals_diff: 0,
    points: 0,
  };
}

function applyResult(stats, scored, conceded) {
  stats.games_played += 1;
  stats.goals_for += scored;
  stats.goals_against += conceded;
  stats.goals_diff = stats.goals_for - stats.goals_against;
  if (scored > conceded) {
    stats.wins += 1;
    stats.points += 3;
  } else if (scored === conceded) {
    stats.draws += 1;
    stats.points += 1;
  } else {
    stats.loses += 1;
  }
}

function blankPlayer(name) {
  return { name, goals: 0, penalty: 0, assists: 0, penalty_make: 0 };
}

function loadSeason(seasonKey) {
  const dir = join(SEASONS_DIR, seasonKey);
  const season = {
    key: seasonKey,
    config: readJson(join(dir, "config.json")),
    teams: {},
    games: [],
  };
  for (const f of listJson(join(dir, "teams"))) {
    const team = {
      key: f.replace(/\.json$/, ""),
      ...readJson(join(dir, "teams", f)),
    };
    team.games = [];
    if (!team.players) team.players = { starting: [], subs: [] };
    season.teams[team.key] = team;
  }
  for (const f of listJson(join(dir, "games"))) {
    const key = f.replace(/\.json$/, "");
    const game = {
      key,
      slug: gameSlug(key),
      seasonKey,
      ...readJson(join(dir, "games", f)),
    };
    season.games.push(game);
  }
  // Extra files for special seasons (player contest).
  for (const extra of [
    "players",
    "all-players",
    "GSF",
    "autogen-config-example",
  ]) {
    try {
      season[extra.replace(/-/g, "_")] = readJson(join(dir, `${extra}.json`));
    } catch {
      // not present in this season
    }
  }
  return season;
}

function enrichSide(season, side) {
  const team = season.teams[side.key];
  if (team) {
    side.display_name = team.display_name;
    side.display_name_zh = team.display_name_zh;
    side.logo = team.logo;
    team.games.push(side.__game);
  } else {
    side.display_name = side.display_name ?? side.key;
    side.logo = side.logo ?? "question-mark.png";
  }
}

// Port of add_player_to_goal_scorers / add_player_to_assists.
function buildPlayerStats(season) {
  const playerHash = {}; // teamKey -> name -> player record
  for (const [teamKey, team] of Object.entries(season.teams)) {
    playerHash[teamKey] = {};
    for (const p of [...team.players.starting, ...team.players.subs]) {
      playerHash[teamKey][p.name] = { ...blankPlayer(p.name), ...p };
    }
  }
  const ensure = (teamKey, name) => {
    playerHash[teamKey] ??= {};
    playerHash[teamKey][name] ??= blankPlayer(name);
    return playerHash[teamKey][name];
  };
  // Player may be a plain name or a loan form { player, team }.
  const resolve = (teamKey, ref) =>
    typeof ref === "string" || ref == null
      ? { teamKey, name: ref }
      : { teamKey: ref.team, name: ref.player };
  for (const game of season.games) {
    for (const side of ["home", "away"]) {
      for (const e of game[side]?.events ?? []) {
        const sideKey = game[side].key;
        if (e.type === "goal" || e.type === "penalty") {
          if (e.player !== "??") {
            const { teamKey, name } = resolve(sideKey, e.player);
            const p = ensure(teamKey, name);
            p.goals += 1;
            if (e.type === "penalty") p.penalty += 1;
          }
        }
        if (
          e.assist != null &&
          (e.type === "goal" || e.type === "penalty" || e.type === "owngoal")
        ) {
          const { teamKey, name } = resolve(sideKey, e.assist);
          const p = ensure(teamKey, name);
          p.assists += 1;
          if (e.type === "penalty") p.penalty_make += 1;
        }
      }
    }
  }
  const all = Object.entries(playerHash).flatMap(([teamKey, byName]) =>
    Object.values(byName).map((p) => ({ ...p, teamkey: teamKey })),
  );
  return {
    scorers: all
      .filter((p) => p.goals > 0)
      .sort((a, b) => b.goals - a.goals || a.penalty - b.penalty),
    assists: all
      .filter((p) => p.assists > 0)
      .sort((a, b) => b.assists - a.assists || a.penalty_make - b.penalty_make),
  };
}

// Knockout brackets GSF contested, resolved for rendering. Two tie shapes:
// [teamA, teamB, gameId] (22q2) and bare game-id strings (23q2-cup).
function buildTrophies(season) {
  const gamesByKey = Object.fromEntries(season.games.map((g) => [g.key, g]));
  const teamOf = (key) =>
    season.teams[key] ?? { key, display_name: key, logo: "question-mark.png" };
  const trophies = [];
  for (const [name, knockout] of Object.entries(
    season.config.knockouts ?? {},
  )) {
    const rounds = (knockout.bracket ?? []).map((round) =>
      round.map((tie) => {
        if (Array.isArray(tie)) {
          const [a, b, gameId] = tie;
          return {
            team0: teamOf(a),
            team1: teamOf(b),
            game: gamesByKey[gameId] ?? null,
            gameId,
          };
        }
        const game = gamesByKey[tie] ?? null;
        return {
          team0: game
            ? teamOf(game.home.key)
            : { key: "?", display_name: "?", logo: "question-mark.png" },
          team1: game
            ? teamOf(game.away.key)
            : { key: "?", display_name: "?", logo: "question-mark.png" },
          game,
          gameId: tie,
        };
      }),
    );
    const contested = rounds.some((round) =>
      round.some(
        (tie) =>
          isGsf(tie.team0.key) ||
          isGsf(tie.team1.key) ||
          (tie.game && (isGsf(tie.game.home.key) || isGsf(tie.game.away.key))),
      ),
    );
    if (contested)
      trophies.push({ name, winner: knockout.winner ?? "", rounds });
  }
  return trophies;
}

// Player contest (juggle): group tables + results + knockout placeholders.
function buildContest(season) {
  const { config } = season;
  const groups = config.group_stage ?? {};
  const rawGames = config.games ?? {}; // "G-A-name0-name1" -> [s0, s1] | []
  const groupGames = {}; // groupKey -> [{name0, name1, score}]
  const table = {}; // groupKey -> name -> stats {games_played, wins, draws, loses, scores, points}

  for (const [groupKey, names] of Object.entries(groups)) {
    table[groupKey] = Object.fromEntries(
      names.map((n) => [
        n,
        { games_played: 0, wins: 0, draws: 0, loses: 0, scores: 0, points: 0 },
      ]),
    );
    groupGames[groupKey] = [];
  }
  for (const [gameKey, score] of Object.entries(rawGames)) {
    // K-<...> are knockout games; G-<group>-<n0>-<n1> are group games.
    const parts = gameKey.split("-");
    if (parts[0] !== "G") continue;
    const [, groupKey, n0, n1] = parts;
    const entry = {
      name0: n0,
      name1: n1,
      score: Array.isArray(score) ? score : [],
    };
    groupGames[groupKey] ??= [];
    groupGames[groupKey].push(entry);
    if (
      entry.score.length === 2 &&
      table[groupKey]?.[n0] &&
      table[groupKey]?.[n1]
    ) {
      const [s0, s1] = entry.score;
      for (const [name, mine, theirs] of [
        [n0, s0, s1],
        [n1, s1, s0],
      ]) {
        const t = table[groupKey][name];
        t.games_played += 1;
        t.scores += mine;
        if (mine > theirs) {
          t.wins += 1;
          t.points += 3;
        } else if (mine === theirs) {
          t.draws += 1;
          t.points += 1;
        } else {
          t.loses += 1;
        }
      }
    }
  }
  // Group ranking: points, then total juggle count.
  const groupTables = Object.fromEntries(
    Object.entries(table).map(([groupKey, byName]) => [
      groupKey,
      Object.entries(byName)
        .map(([name, s]) => ({ name, ...s }))
        .sort((a, b) => b.points - a.points || b.scores - a.scores),
    ]),
  );
  // Resolve knockout placeholders like "A1" (group A rank 1) where possible.
  const resolvePlayer = (token) => {
    const m = /^([A-Z])(\d)$/.exec(token);
    if (m && groupTables[m[1]]?.[Number(m[2]) - 1])
      return groupTables[m[1]][Number(m[2]) - 1].name;
    return token;
  };
  const knockoutRounds = (config.knockout_stage ?? []).map((round) =>
    round.map((tie) => {
      if (typeof tie !== "string") return null;
      const [, , p0, p1] = tie.split("-"); // K-<round>-<p0>-<p1>
      return {
        name0: resolvePlayer(p0 ?? ""),
        name1: resolvePlayer(p1 ?? ""),
        score: [],
      };
    }),
  );
  return {
    groups,
    groupGames,
    groupTables,
    knockoutRounds,
    winner: config.winner ?? "",
  };
}

export function buildSeasons() {
  const seasons = {};
  for (const seasonKey of readdirSync(SEASONS_DIR).sort()) {
    const season = loadSeason(seasonKey);
    const { config } = season;
    season.internal = isInternalEvent(seasonKey, config);
    season.display_name = config.display_name ?? seasonKey;
    season.display_name_zh = config.display_name_zh ?? season.display_name;
    season.winnerTeam = season.teams[config.winner] ?? null;

    if (config.type === "player contest") {
      season.contest = buildContest(season);
      seasons[seasonKey] = season;
      continue;
    }

    for (const game of season.games) {
      for (const sideName of ["home", "away"]) {
        const side = game[sideName];
        if (!side?.key) continue;
        side.__game = game;
        enrichSide(season, side);
        delete side.__game;
      }
    }
    season.games.sort((a, b) => a.key.localeCompare(b.key));

    const stats = buildPlayerStats(season);
    season.scorers = stats.scorers;
    season.assists = stats.assists;
    season.trophies = buildTrophies(season);

    // Full league table only for GSF-internal leagues (weekly cup): with the
    // GSF-centric data set, a table over external seasons would be misleading.
    if (config.type === "league_table" && season.internal) {
      const byTeam = Object.fromEntries(
        Object.keys(season.teams).map((k) => [k, blankStats()]),
      );
      for (const game of season.games) {
        if (game.schedule) continue;
        if (!byTeam[game.home?.key] || !byTeam[game.away?.key]) continue;
        applyResult(byTeam[game.home.key], game.home.score, game.away.score);
        applyResult(byTeam[game.away.key], game.away.score, game.home.score);
      }
      season.table = Object.entries(byTeam)
        .map(([key, s]) => ({ team: season.teams[key], ...s }))
        .sort(
          (a, b) =>
            b.points - a.points ||
            b.goals_diff - a.goals_diff ||
            b.goals_for - a.goals_for,
        );
    }

    // Per-team season stats (for team pages' history tables).
    for (const team of Object.values(season.teams)) {
      const s = blankStats();
      for (const game of team.games) {
        if (game.schedule) continue;
        const isHome = game.home.key === team.key;
        applyResult(
          s,
          isHome ? game.home.score : game.away.score,
          isHome ? game.away.score : game.home.score,
        );
      }
      s.avg_gf = s.games_played
        ? (s.goals_for / s.games_played).toFixed(1)
        : "0.0";
      s.avg_ga = s.games_played
        ? (s.goals_against / s.games_played).toFixed(1)
        : "0.0";
      team.seasonStats = s;
    }

    seasons[seasonKey] = season;
  }

  // Cross-season history per team key.
  const history = {}; // teamKey -> [{season_key, display_name, display_name_zh, is_winner, ...stats}]
  for (const [seasonKey, season] of Object.entries(seasons)) {
    if (season.config.type === "player contest") continue;
    for (const [teamKey, team] of Object.entries(season.teams)) {
      history[teamKey] ??= [];
      history[teamKey].push({
        season_key: seasonKey,
        display_name: season.display_name,
        display_name_zh: season.display_name_zh,
        is_winner: season.config.winner === teamKey,
        ...team.seasonStats,
      });
    }
  }
  for (const list of Object.values(history))
    list.sort((a, b) => b.season_key.localeCompare(a.season_key));

  return { seasons, history };
}

const { seasons, history } = buildSeasons();

export const seasonPages = seasons;
export const teamHistory = history;

// Jekyll-shaped alias for legacy post bodies:
// site.data.seasons["22q4"].games["2022-08-06-1"].
export const seasonsJekyll = Object.fromEntries(
  Object.entries(seasons).map(([key, s]) => [
    key,
    {
      ...s,
      games: Object.fromEntries(s.games.map((g) => [g.key, g])),
    },
  ]),
);

// Flat lists for pagination.
export const gamesFlat = Object.values(seasons)
  .filter((s) => !s.contest)
  .flatMap((s) => s.games);

export const teamsFlat = Object.values(seasons)
  .filter((s) => !s.contest)
  .flatMap((s) =>
    Object.values(s.teams).map((team) => ({
      ...team,
      seasonKey: s.key,
      historyStats: history[team.key] ?? [],
      seasonGames: team.games,
    })),
  );

export const seasonsList = Object.values(seasons);

export const statsSeasons = seasonsList.filter((s) => !s.contest);

export const navLists = seasonsList
  .map((s) => ({
    key: s.key,
    display_name: s.display_name,
    display_name_zh: s.display_name_zh,
  }))
  .sort((a, b) => b.key.localeCompare(a.key));

// Tolerant game lookup for match-report posts: exact key first, then a
// normalized match ignoring separators and an optional inserted kickoff time
// (some posts' game_key front matter omits the time part of the data key).
export function findGame(gameKey, seasonKey) {
  const season = seasons[seasonKey];
  if (!season) return null;
  const exact = season.games.find((g) => g.key === gameKey);
  if (exact) return exact;
  // Drop the kickoff time token ("2025-10-04 19:00-EBU..." -> date+teams).
  const stripTime = (s) => String(s).replace(/[\s_]+\d{1,2}:?\d{2}(?=-)/, "");
  const target = norm(stripTime(gameKey));
  return (
    season.games.find((g) => {
      const k = norm(stripTime(g.key));
      return k === target || k.startsWith(target) || target.startsWith(k);
    }) ?? null
  );
}
