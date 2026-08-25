# AGENTS.md — app/ contributor guide (humans and AI agents)

Guidance for working on the member app in `app/`, for any tool or model. The
repo-wide rules live in the root `AGENTS.md`; this file covers app internals.

## What this is

The GSF soccer club member app (https://app.gsffc.org), built as a POC for
GPS-based event check-in. Express 4 + EJS server-rendered pages, PostgreSQL for data and sessions,
deployed to Netlify as a single serverless function. UI text is Chinese; code comments are English.

## Commands

```bash
npm install
npm start          # node server.js -> http://localhost:3000
netlify dev        # simulate the Netlify function + redirect setup locally (needs netlify-cli)
```

There is no test suite, linter, or build step. `public/` is served as-is.

## Git commit messages

Every commit message has **three parts, in this order**:

1. **The technical summary** — what a developer would write for other developers, in English or Chinese
   as the repo already does. Short and concise: a subject line, plus a few bullets only when the change
   really spans several things. No release-note prose here.
2. **`管理员发布说明`** — a short Chinese release note for admins, **written as bullet points** (`- `),
   a few of them at most: what is new or changed and what an admin can now do, in plain language.
   Features only — **no technical detail of any kind and no deployment/database steps** (a
   `db/schema.sql` re-run, a new env var, a manual SQL update): all of that belongs in part 1.
3. **`会员发布说明`** — a Chinese release note for members, **also bullet points**. Short and concise,
   one or two bullets in plain language about what they will see or can do; no internals, no admin-only
   steps. Say `- 无` (or `- 本次更新对会员无影响`) when a change is invisible to members.

Skip none of the three, even for a small change — a trivial commit just makes each part one bullet.

```
event page: show auto-assigned teams above the roster

- pickTeam fills teams 1/2 first, 3 is uncapped overflow
- teams derived on read; only team_no is stored

管理员发布说明：
- 签到时自动分队，活动分成三队。
- 队伍人数按已报名人数加试训批准人数计算。

会员发布说明：
- 签到后即可在活动页面看到自己的分队。
```

## Database setup (manual — the app never provisions it)

`db/schema.sql` must be executed by hand against the target Postgres **before first run** — no code path
runs it, `db.js` only opens a pool and queries. Consequences to remember:

- Adding a column means editing `db/schema.sql` *and* applying it manually to every existing database.
- `db/schema.sql` is the **only** DDL there is — there are no migration files. It is written to be safe
  to re-apply (`CREATE … IF NOT EXISTS`, `ON CONFLICT DO NOTHING`), so an existing database is moved
  forward by running it again. A new column on an existing table goes in **twice**: in the `CREATE TABLE`
  for a fresh database, and again as `ALTER TABLE … ADD COLUMN IF NOT EXISTS` for one that already has
  the table. Both forms are
  idempotent, so the file stays safe to run as a whole; anything that still can't be expressed that way
  (a CHECK, which has no `IF NOT EXISTS`) goes in wrapped in a
  `DO $$ … EXCEPTION WHEN duplicate_object $$` block, which makes it idempotent too — that is how
  `event_guests.status` went in, column and CHECK together, and it is preferred over the older habit of
  applying such a CHECK by hand in `psql`. (**`events.visibility` predates this and is missing its
  `ALTER`**, so a database created before that column never got it — which no longer matters, since
  nothing reads or writes the column any more; see 可见范围 below.)
  A whole new table needs neither form — `CREATE TABLE IF NOT EXISTS` covers both cases, constraints
  included, which is how `gsffc.event_guests` went in.
- **Dropping a column is the one thing this file deliberately does not do.** It is run repeatedly, and
  destructive DDL has no place in that, so a column removed from the app is left in the live database
  and dropped by hand with an `ALTER TABLE … DROP COLUMN` in `psql`. Nothing reads it in the meantime,
  so an existing database goes on working untouched until somebody does.
- `db/schema.sql` seeds only the three events; it seeds **no users**. Members are created from the
  "批量添加会员" modal on `/members` (paste `username:password` lines); its button and the modal
  itself only render for admins.
  Both `POST /members/add-users` and `POST /api/users` require an
  ADMIN session (both answer JSON — see 批量添加会员 below), so the very first account still has to be INSERTed by hand with a bcrypt hash — and
  then promoted with `UPDATE gsffc.users SET role = 'ADMIN' WHERE email = …`, or nobody can add anyone.
- Everything lives in the hardcoded `gsffc` schema (`SCHEMA` in [db.js](db.js#L6)); every query is
  prefixed with it. The `express-session` table is created automatically by `connect-pg-simple`
  (`createTableIfMissing: true`) in that same schema.
- `DATABASE_URL` must be a Postgres connection string (`postgres://…`), not a Supabase REST URL.

## Architecture

**Single app object, two entry points.** [server.js](server.js) builds and exports the Express app and
only calls `listen()` when `require.main === module`. On Netlify,
[netlify/functions/server.js](netlify/functions/server.js) wraps the same export with `serverless-http`
and sets `callbackWaitsForEmptyEventLoop = false` so the pg pool survives between invocations. Never
add top-level `listen()` or process-lifetime assumptions to `server.js`.

**Serverless bundling constraints** ([netlify.toml](netlify.toml)): esbuild can't trace EJS, so `ejs` is
in `external_node_modules` and `views/**` in `included_files`. Any new runtime-loaded file (new template
dir, data file) must be added to `included_files` or it will 500 only in production. [server.js](server.js#L15)
resolves the views dir from `__dirname` *or* `process.cwd()` for the same reason.

**Data shape.** `db.js` is the only module touching SQL. `rowToEvent` maps the flat row to the app's
event object: `lat`/`lng` columns collapse into `coords` (or `null` for online events) and
`checkin_radius` into `checkinRadius`.

**An event's when is `start_at`/`end_at`, `TIMESTAMP` *without* time zone.** A club schedule is a wall
clock — "16:00 at the pitch" — not an instant, so it must not move with the server's zone (UTC on
Netlify, local in dev); `TIMESTAMPTZ` would convert on the way in and out and push evening events across
midnight. For the same reason `db.js` **remaps pg type OID 1114 with `types.setTypeParser`** to hand the
value back as the string Postgres sent, trimmed to `'YYYY-MM-DDTHH:MM'`, instead of a JS `Date`: a `Date`
is a point in time and `JSON.stringify` calls `toISOString()` on it, so `/api/events` would answer
`2026-06-13T23:00:00.000Z` for a 16:00 event on a Pacific box and `16:00Z` on Netlify. That remap is
global to the `pg` module, but only 1114 is touched — the roster's `TIMESTAMPTZ` columns (1184) are real
instants and keep their `Date` parsing. Two `CHECK`s hold the shape: `end_at > start_at`, and
`date_trunc('minute', …) = …` so nothing ever stores seconds the minute-precision form can't show.

`rowToEvent` exposes the two columns as `startAt`/`endAt` and slices three **read-only** fields out of
them — `date`, `endDate` and `time` (`'16:00 - 18:00'`, the exact shape the old free-text column had,
which is why the calendar chip and its tooltip needed no rewrite). Same arrangement as
`signups`/`checkins` over `roster`: nothing writes through them, and they are deliberately absent from
`EDITABLE_FIELDS`. `event.date` is what the calendar groups by and what is compared lexically against
the `todayStr()` helper to decide which days are past. Whether a single *event* is over is no longer
day-granular: `hasEnded(event)` compares `clubEpoch(event.endAt)` against now, so 已结束 and the closed
check-in both land on the minute the event ends (see the timezone section under check-in). Since
`startAt`/`endAt` are fixed-width and identically formatted, every comparison on them (ordering,
end-after-start, in SQL and in JS and in the browser) is a plain string comparison.

**The roster is two tables, `gsffc.event_signups` and `gsffc.event_checkins`** — one row per member per
event, each carrying its own timestamp (`signed_up_at`, `checked_in_at`). They replaced a pair of JSON
string columns on `events` that held bare arrays of emails and recorded no times at all; those columns
are gone from `db/schema.sql` and nothing reads them any more. Consequences:

- `rowToEvent` takes the event's signup rows as a second argument and hangs **`event.roster`** off the
  event — the ordered list of `{email, status, signedUpAt, promotedAt, checkedInAt, checkinDistance}`,
  with the check-in LEFT JOINed onto the signup it belongs to. `getRosters` fetches them for a whole
  page of events in one query, so `getEvents` costs two round trips, not N.
- `event.signups`, `event.waitlist` and `event.checkins` are **derived from `roster`**, arrays of bare
  emails. The first and last keep the exact shape the old columns had, which is why the templates and
  the JSON API needed no rewrite; `waitlist` is the new one. They are read-only views — nothing writes
  through them any more.
- **`db.updateEvent` no longer touches the roster.** Every roster write is its own function —
  `signUpForEvent`, `withdrawFromEvent`, `clearEventRoster`, `checkInToEvent` — and each of the first
  three runs inside `withEventLock`, a transaction holding `SELECT … FOR UPDATE` on the event row. That
  is what makes "is there room?" and "take the place" atomic: the old read-modify-write could lose a
  concurrent signup, and two members racing for the last place could both get it. Add roster writes as
  new functions in that shape; never mutate an array and re-save the event.
- `email` carries **no foreign key to `users`** (the seeds name members who may have no account), so
  `deleteUser` still cascades by hand — see below.

**可见范围 is gone: an event is visible to every member, and the only thing that holds one back is
报名开放时间.** `events.visibility` used to decide who the event existed for at all — `'ALL'` /
`'ADMIN'` / one member's lowercase email — with a 可见范围 `<select>` and a 指定成员 picker on the event
form. All of it has been removed: `db.canSeeEvent`, `db.normalizeVisibility`, the `VISIBLE_*` constants,
`visibilityLabel`, `checkVisibilityTarget`, the two `<select>`s and `syncVisibility`, the `visibility`
entry in `EDITABLE_FIELDS`, and the column from `createEvent`/`updateEvent`'s INSERT/UPDATE. The
Wednesday 20:00 rule below already does the one thing it was used for — keeping the club out of a
fixture until the week's 试训 are arranged — and a second, hand-set rule layered on it could only end up
disagreeing with it.

**The column is still in `db/schema.sql`**, with its default and its CHECK, because that file is
re-applied to live databases and does no destructive DDL — the same treatment every removed column gets.
Nothing reads or writes it, so an event that was restricted before this change is simply open now, and
no SQL is needed to open it. Dropping the column for real is an `ALTER TABLE … DROP COLUMN` by hand.

Who may see an event is still an access decision, not a rendering one, so it takes the same care as
`requireAdmin`: the `role` `canSee` is given must be the row re-read from the database, never
`req.session.user.role`, which can be 30 days stale. `viewer(req, role?)` in
[server.js](server.js#L133) is what produces it — one `getUserByEmail`, with the session copy refreshed
on the way through, or none at all when the caller already has the fresh row (`/event/:id` reads every
member for its roster, so the viewer's own row is already in that Map).

**An event the viewer may not see answers exactly as a missing one does — 404, never 403**, since a
refusal would confirm it exists. Every route that hands an event out or writes to its roster applies the
rule: `/calendar` and `/api/events` **filter the array before anything is built out of it** (so no
count, tooltip or map centre can leak one), `/event/:id`, `GET|PUT /api/events/:id`,
`POST /event/:id/signup` and `POST /event/:id/checkin` 404. **Withdrawing is deliberately not gated** (as
long as the member has not checked in, which is a separate refusal — see 迟到罚款/check-in below). The
admin-only routes (清空报名, 删除活动) need no check, since admins see everything. A new route that hands
an event out must call `canSee` too.

**报名开放时间 — 20:00 club time on the Wednesday before the event — is the other half of who may see
it.** It is a club-wide rule, not a per-event field: the club opens every week's signups at the same
moment, so there is nothing for an admin to fill in and nothing that can be set wrong.
`signupOpensAt(event)` in [server.js](server.js) is the instant — the **last** Wednesday 20:00 strictly
before kick-off, so it always falls inside the week running up to the event (a Saturday match opens on
the Wednesday three days earlier; a Wednesday match at 19:00 opens a full week ahead rather than an hour
after it has finished). The date arithmetic is done in UTC on the **wall-clock date** and only the
finished wall clock goes through `clubEpoch`, so it lands on 20:00 in the club's zone on both sides of a
DST change. `SIGNUP_OPEN_DOW`/`SIGNUP_OPEN_TIME` are the two constants; an unparseable `startAt` answers
NaN and the gate falls back to open, like every other one here.

**Before it, the event exists for administrators only** — that is what gives them the window to arrange
the week's 试训 before the club is let at the places. `canSee(event, user)` in [server.js](server.js) is
therefore **the** rule, and the whole of it now that 可见范围 is gone: an `ADMIN` short-circuit, then
`signupOpen(event)`. A member is refused exactly as they are refused a missing event — the calendar and
`/api/events` filter it out before anything is built from it, and every route handing one out 404s
rather than 403ing. A new route that hands out an event must call `canSee`.

**报名 itself opens at the same instant, for everybody — administrators included.** The pre-open window
is for arranging 试训, not for taking places ahead of the club, so `POST /event/:id/signup` carries its
own `signupOpen` gate and redirects back unchanged, the same shape as the frozen 清空报名; the page
renders the reason (⏳ 报名 … 开放) where the button would be. What an admin *can* do in that window is
添加/移出 试训/Guest, which is not gated on it at all — those routes are admin-only and never went
through `canSee` — and a guest added then is **confirmed on the spot**, since no member has taken a
place yet. On the calendar the pre-open state is what the chip's lock now means: `/calendar` hangs
`signupNote(e)` off each event as `e.signupNote`, and that alone raises the amber
`.cal-event.is-restricted` chip, its lock and its tooltip. Only an admin is ever looking at a pre-open
event, so the lock only ever appears to somebody allowed to see it. On the event page it is its own
amber badge beside the title.

**No headcount is stored on an event but 总人数.** The team size is `已报名人数 + 试训人数`,
derived on every read from `event_signups` and `event_guests` (`db.teamSizes`, below), and 总人数
(`capacity`) caps the event without sizing anything. A hand-typed number describing a roster the app
already holds can only ever fall out of agreement with it, while the two numbers the club genuinely
maintains — the signups and the 试训/Guest an admin added — already add up to the answer.

**总人数 counts every body coming, member and 试训 alike** — it used to be 人数上限, a members-only
number that the guests sat on top of, so an event set to 22 with three 试训 actually held 25.
It now caps the two together: `db.countPlaces` is the one count (`confirmed event_signups` +
`confirmed event_guests`), `rowToEvent` exposes it as **`event.placesTaken`/`event.placesLeft`**,
and every "is there room?" test in db.js reads it — `signUpForEvent`, `addEventGuest` and
`promoteFromWaitlist` alike. The consequence the club asked for follows on its own:
**adding a 试训 takes a place off the members**, because there is only ever one pool of places.
`MAX_EVENT_GUESTS` (3) is a *different* cap counting a different thing — how many 试训/Guest an event may
have **at all**, waitlisted ones included — so the fourth guest is refused outright while the third
can perfectly well be added onto the waitlist of an event the members have already filled.

**队伍数量 is the admin's, and it is the one part of a team that is stored on the event.**
`events.team_count` is **2, 3 or 4** (default 3, which is what every row written before the column reads
as), picked from a `<select>` on the event form beside 总人数. It used to be a hardcoded `TEAM_COUNT = 3`
in db.js, which meant a 板凳 on an event the club was playing four-a-side. `db.TEAM_COUNTS` is the list,
`db.normalizeTeamCount` is what nothing gets past — it throws on a stated value that is not one of the
three and answers the default for an absent one, and it is
called inside `createEvent`/`updateEvent` as well as from `validateEvent`, so the column cannot be
reached unnormalized. A CHECK (`team_count BETWEEN 2 AND 4`) is the backstop. It is in `EDITABLE_FIELDS`,
so a PUT that omits it keeps the current value, and `rowToEvent` exposes it as `event.teamCount`.

**The teams are named by count**, and the names are UI text — db.js knows only numbers:

| 队伍数量 | 1 | 2 | 3 | 4 |
| --- | --- | --- | --- | --- |
| 2 | ♠️ 黑桃 | ♥️ 红桃 | | |
| 3 | ♠️ 黑桃 | ♥️ 红桃 | 🪑 板凳 | |
| 4 | ♠️ 黑桃 | ♥️ 红桃 | ♣️ 梅花 | ♦️ 方片 |

**The last team is the overflow in every layout** — which is what makes the 3-team one's last team a
bench, and what makes the 2- and 4-team ones' last team an ordinary side that happens to also absorb the
overflow. Changing 队伍数量 on a live event **re-sizes the teams immediately** (the size is derived on
every read) and **re-allocates nobody**, exactly as a signup or an 添加 does; lowering it past a team
that already holds members leaves those members standing in a team that no longer exists in the layout.

**自动分队 is decided at check-in, and only the random draw is stored.** An event is split into
`event.teamCount` teams sized by `db.teamSizes(signedUp, confirmedGuests, teamCount)` — everybody who is
coming divided that many ways, **均分 with the remainder handed out from the first team forward**, so it
answers **one number per team** rather than a single size: 9 in four teams is 3 / 2 / 2 / 2, 9 in two is
5 / 4, 9 in three is 3 / 3 / 3, 25 in three is 9 / 8 / 8. Forwards is the mirror of `guestQuota`'s
backwards and for the same reason: 黑桃 is the first team filled, so the odd body lands where the
arrivals are already going. **It used to be one number for every team — the total rounded up** — which is
a size no uneven split can be true of: 9 in four teams gave four teams of 3, i.e. room for 12, so the
page promised places the event did not have and 方片 was left standing empty while 梅花 filled.
**Who is coming is
已报名人数 + 试训人数**: the event's confirmed `event_signups` plus its **confirmed**
`event_guests`. The **waitlist is deliberately not in it**, and that now cuts both ways — neither a
waitlisted member nor a waitlisted 试训 has a place at the event yet, so neither is anybody's teammate
until they are promoted, at which point the size grows on its own. `capacity` (总人数) has **no part**
in it either: it caps the event, it does not size the teams.

`teamSizes` answers `null` only for an event with nobody on it at all — no signups and no guest
— and the first signup makes it `[1, 0, 0]`. A team's number is legitimately **0** when fewer people are
coming than there are teams. Both halves are already in hand wherever it is called, so it costs no
query of its own: `rowToEvent` counts them off the roster and the guest rows it was handed, `pickTeam`
reads both under the event lock.

The sizes are derived on every read, never written, so the teams **re-size as members sign
up, withdraw or are promoted, as guests are added or 移出'd, and as an admin changes 队伍数量** — the same way
correcting `startAt` re-prices its 迟到罚款. The one thing that cannot be re-derived is which team a
member drew, and that is the whole content of `event_checkins.team_no` (1..`team_count`, NULL for "not
allocated"). It rides on the check-in row rather
than in a table of its own because a member is allocated **by arriving**: 清空报名, deleting the member
and deleting the event all drop that row and take the allocation with it, so there is no new cascade
anywhere. Withdrawing no longer does, because a member who has arrived can no longer withdraw at all —
see 迟到罚款/check-in below. `db/schema.sql` deliberately carries **no CHECK** on that column —
`pickTeam` in [db.js](db.js) is what keeps it inside the event's own count.

`pickTeam` is the club's rule exactly, in all three layouts: **each team is filled to its own number**
(`teamSizes[team - 1]`, never one figure shared by all of them), **黑桃/红桃 are the only teams drawn
between** — a random one of the two (`crypto.randomInt`) while both have room, the one that still has
room once the other is full — **every team after them is filled in order**, and **whatever is left over
goes into the last team, which is the overflow and is deliberately uncapped**. So 黑桃/红桃 fill first
everywhere; a 2-team event then keeps pouring into 红桃, a 3-team one onto the 板凳, and a 4-team one
fills 梅花 to its number before anybody reaches 方片.

**The draw used to run in pairs** — 黑桃/红桃, then a second random one between 梅花/方片 — which made
the two late teams interchangeable. They are not, and filling them in order is what makes arriving
earlier worth something: 梅花 closes before 方片 opens, so the last arrivals are the ones who land in the
overflow. The order is the arrival order and nothing else — it is not a punishment the app records
anywhere, and 迟到罚款 stays the only thing that prices lateness.

It is not round-robin, and that has a visible consequence: the sizes count everybody signed up and every
guest, and plenty of them never check in — so 21 expected in three teams with 15 arrivals gives
7 / 7 / 1 rather than an even split. That is intended. Two things leave `team_no` NULL: an event with
**nobody on it at all** (no signups and no guest, where `teamSizes` answers null), and any
check-in made before the feature existed.

**The sizes move after people have been allocated, and nobody is ever re-allocated.** A signup, a
withdrawal, a promotion off the waitlist or an 添加 all change them, but allocation only ever
happens at the moment of check-in — so a team can end up holding more than its current number (members
withdrawing after arriving) or less (people signing up after the early arrivals were drawn). That trade
is deliberate, and it is why `pickTeam`'s last team is uncapped. A re-allocation entry point would be a
new function holding the event lock.

**试训/guest places are shared out evenly, not drawn.** A trialist or a guest has no account, so they can
never sign up, never check in and are never on the roster — `gsffc.event_guests` is the only record of
them (see 试训/Guest below), and `db.eventGuests(guests, size, taken, teamCount)` turns its **confirmed**
rows into their places. It is two steps, and neither is random:

1. **How many places each team gets** is `db.guestQuota(count, teamCount)`: **均分, with the remainder
   handed out from the last team backwards**. 2 teams and 1 guest → 红桃; 3 teams and 2 → 板凳 then 红桃;
   4 teams and 3 → 方片, 梅花, 红桃. Backwards, because 黑桃 is the first team filled at check-in, so a
   place held back there is the one most likely to be wanted by an arriving member — and with fewer
   guests than teams the remainder never reaches 黑桃 at all.
2. **Which guest takes which** is **申请时间 order** (`requestedAt`, ties on the id) poured down the teams
   in the order they are filled at check-in (黑桃 → 红桃 → …), so the earliest request lands in the first
   team with a place for one.

It answers those same guests each with a `team`, **ordered by it**, and `rowToEvent` hangs the result off
the event as `event.guests` — a derived read-only view like `teams` itself. Guests are deliberately
**not** in `event.teams`: that is the roster grouped by team, and a guest has no email to appear in it.

**An earlier version of this rule is gone.** The *placement* used to be hardcoded as 1 → bench / 2 →
bench plus one playing team (from a sum over the event id) / 3 → one each, which only ever described a
3-team event — `guestQuota` replaced that, and the even split gives the same answer for the 3-guest case
it used to. `capacity` has no part in it. `db.MAX_EVENT_GUESTS` still caps an event at three
guests, so the quota never has to divide more than three.

**A full team takes no guest — the place goes to the last team.** Only the last team is uncapped, so a
guest placed into a team already holding **its own** `teamSizes` number of members would put it one past
it (the test is per team, not against a shared size, so 黑桃 and 红桃 can fill at different numbers), and the
members standing in it are already allocated and are never moved. This is not a rare case: it is what
happens whenever a guest is added after people have started checking in — the teams re-size but
nobody is re-allocated, so the guest place can land on a team that filled up under the old size. `taken`,
the third argument, is what makes that visible — a Map of team → the number of
**members** already in it, from the caller that has them (`rowToEvent` from `event.teams`, `pickTeam` from
its own count query). It is members only; the guest places being decided are counted on top of it as they
are placed, so two guests can never be handed the same last place. The bump only ever moves one way, and
it is not a fresh draw — both callers decide it from the same check-in rows, so the page and the arrivals
cannot disagree.

**`pickTeam` counts the guest places as already taken.** Nothing else would ever hold them back — a
trialist cannot check in — so the last member to arrive would simply take the place meant for them, and
the page showing a guest in ♠️ would be describing a team that is actually full of members. That is also
why the placement **cannot** be a draw the way a member's is: it is derived on every read, so a fresh
draw would move between renders *and* disagree with the room `pickTeam` left. 申请时间 and arithmetic are
what make both callers reach the same answer from the same rows — `eventGuests` sorts its input itself
rather than trusting the order the query handed it, since `getEventGuests` orders by 添加时间 (the order
the page lists them in) and `pickTeam` reads its own.

Because the guests' teams depend on those same counts, **`pickTeam` derives them itself** rather than
being handed them: it takes `(client, eventId, event)` — the row `withEventLock` hands over, which is
where `team_count` comes from — counts the confirmed signups and the check-ins per team, **SELECTs the
event's confirmed guest rows inside the same lock**, calls `db.eventGuests` with that members-only Map,
and only then adds the guest places to it before testing for room. Those reads are inside the lock with
everything else, so an 添加 landing mid-check-in is serialised against them rather than being counted
twice or not at all.

**`checkInToEvent` therefore runs inside `withEventLock`** and is no longer a lone INSERT: picking a team
means counting the teams first, and that read-then-write is exactly what two simultaneous arrivals would
interleave — the same reason every roster write is locked. The lock also hands over the event row the
team size is computed from. It now answers `{checkedInAt, team, created}` (`created` false when the member
was already checked in, carrying the **first** row's team, so a double submit can never move somebody) or
`null` when the event is gone, which both check-in routes now 404 on rather than reporting a success
nothing recorded. `rowToSignup` exposes the column as `roster[].team`, and `rowToEvent` derives
`event.teamSizes` (one number per team, null when nobody is coming) and `event.teams` (always
`event.teamCount` arrays of emails, an empty team being an
empty array) as read-only views beside `signups`/`waitlist`/`checkins`. Both check-in routes return
`team` in their JSON.

**A 试训/Guest can be on the waitlist.** 总人数 counts them like a member, so
`event_guests` carries the same `status`/`promoted_at` pair `event_signups` does and `addEventGuest`
decides it under the lock against `db.countPlaces` — confirmed when there is room, `WAITLIST` when the
event is already full, served from the one queue in 添加时间 order (see Waitlist above). Only the
**confirmed** half sizes the teams and is placed into them (`event.confirmedGuests`, which is what
`rowToEvent` hands `eventGuests` and what `pickTeam` selects) — a queueing guest is not at the event yet.
`event.guestList` is **both** halves, because that is what `MAX_EVENT_GUESTS` counts. In the sidebar the
block holds two lists — 名单 then 候补 (each waiting row carrying its place in the shared queue, in the
same blue as the roster grid's `.roster-queue` badge) — and `guestView` hangs **`waitlisted`** off every
row for both renderers, the same arrangement as `isTrial`.

**试训/Guest is an admin's list, and nothing else writes it.** `gsffc.event_guests` is the club's record
of the people coming who have no account — the thing 自动分队 places (above) and the thing an admin
manages. A row exists because an admin **添加**'d it, and 移出 **deletes** it; there is no pending state,
no member-facing 申请 and no approval step. That is a deliberate simplification of an earlier design in
which any member could 申请 a place and an admin 批准'd it: `requestEventGuest`, `cancelEventGuest`,
`approveEventGuest`, `unapproveEventGuest`, `guestRequestsClosed`, `canRequestGuest`, the
`GUEST_REQUEST_ENABLED` flag, the member's two form routes and the `?guest=` banners are all gone with
it. `type` is the uppercase keyword (`TRIAL`/`GUEST`, a CHECK, `db.GUEST_TYPES`) and 试训/Guest are the
labels `server.js`'s `GUEST_TYPE_LABELS` renders it as — same arrangement as `users.role`. `name` is free
text the admin typed, trimmed and capped at 40 by `normalizeGuestName`. Both emails carry **no foreign
key** to `users`, for the reason `event_signups.email` doesn't and one more besides: a guest is a body
the club is expecting, so deleting the member who invited them must not un-invite them.

**The two approval columns stayed, under new meanings.** `approved_by`/`approved_at` are the 添加人 and
添加时间 — always set by `addEventGuest`, exposed by `rowToGuest` as **`addedBy`/`addedAt`** and by
`guestView` as `addedByName`/`addedAt`. The columns keep their old names because `db/schema.sql` never
rewrites a column destructively, so renaming one would be a hand-run `ALTER` on the live database for a
cosmetic gain. `requested_by`/`requested_at` are the dialog's **申请人** and when the row was written.
Rows left pending by the old flow have both approval columns NULL and now read as ordinary guests —
nothing filters on `approved_at` any more, in JS or in SQL — so a stale request from that era counts as a
place and can simply be 移出'd.

The rules, and each one's reason:

- **One cap, counted under the lock.** `db.MAX_EVENT_GUESTS` (3) caps the rows per event, waitlisted
  ones included, and `db.countEventGuests` is counted inside `withEventLock` because counting and then
  writing is exactly what two admins tapping 添加 at once would interleave. It cannot be a constraint —
  db/schema.sql can't express "three rows per event". It is a *different* cap from 总人数, which counts
  bodies: the fourth guest is refused outright, while the third can perfectly well be added onto the
  waitlist of an event the members have already filled.
- **添加 is the only way in.** `addEventGuest` inserts the row already holding a place, with the admin as
  `approved_by`, and it lands on the waitlist when the event is full exactly as a member's signup does.
  `requested_by` is the dialog's **申请人** field — a guest an admin adds is usually still coming through
  some member, and 由 X 提交 is what every list of them shows, so 直接添加 asks whose it is rather than
  assuming. It is a `<select>` over the club — the `members` local, which `/event/:id` supplies for
  admins and which exists for this picker alone — **defaulting to the signed-in admin** with `selected`
  in the markup, and an empty/absent value falls back to the admin server-side. The address carries no
  foreign key, so the route checks that it exists — a typo'd one would record the guest as submitted by
  nobody and render as a raw address where a member's name belongs.
- **移出 deletes the row.** A guest is on the event because an admin put them there, so undoing that is
  removing the record of it — there is no pending list to send it back to any more. `removeEventGuest`
  is a `DELETE … RETURNING *` under the event lock, and because the row may have been holding one of the
  event's 总人数 places it **promotes** the head of the queue in the same transaction, exactly as a
  member's withdrawal does; a guest who was only ever waitlisted frees nothing and the promotion is
  skipped. Deleting a row that is already gone answers `missing` rather than throwing — the dialog can
  be double-tapped — and re-adding the guest is the way back, which is what the dialog's warning says.
- **清空报名 deliberately leaves guests alone** (a 试训/Guest is not a member's signup), **删除活动 takes
  them** (a real `ON DELETE CASCADE`), and **`deleteUser` leaves them entirely alone** — the club is
  expecting that body whoever invited them, and the dead address stays on the row as the 申请人 exactly
  as `checked_in_by` keeps a deleted admin's.

**Who sees what: everybody sees the list, only an admin can change it.** `event.guestList` is public —
who else is playing is the same class of fact as the roster — so nothing is filtered out of the API
either. The list was admin-only at first, with a `forViewer` filter on `GET /api/events` and
`GET /api/events/:id` to keep the JSON in step with the page; **that filter is gone** along with the
restriction. The rule it embodied still stands if the list is ever narrowed again: `/event/:id` and both
API routes have to apply the same one, or the names the page hides are a fetch away from the API.
Nothing on the page is per-viewer any more — `isMine` went with 取消. `guestView` is the one mapper both
the page and the dialog go through, so a field added for one is in the other.

**Both routes are the admin's, and both are JSON** (`POST /api/events/:id/guests`,
`POST /api/events/:id/guests/:guestId/remove`, both `requireAdminApi`) because the dialog stays open
across several actions. Neither needs `canSee` — an admin sees every event, so the rule could only ever
pass — and both are frozen once `hasEnded(event)` with a 400, through the shared `guestAction` wrapper,
which also turns db.js's `reason` into the message. There is **no time gate before that**: 添加/移出
stays open right up to the end of the event, because a guest who actually turns up still has to be let
in. (The old member-facing 申请 closed an hour before kick-off, when the check-in window opened; with no
member-facing entry point there is nothing left for that gate to close.)

**Each admin action answers with the event's whole refreshed guest payload**, re-read after the write,
and the dialog redraws the list from it. An 添加 or a 移出 changes the list, how many of the three places
are used and how many of the event's 总人数 places are left, all at once, so moving a row by hand is how
the two come to disagree — `render()` in `#guest-review-modal` is the only thing that writes the list,
the count or any disabled state, exactly like the check-in button's. The list is built **in script** from
`data-guests` for the same reason: two renderers of one list is the bug. Rows are assembled with
`textContent`, never a string of HTML — a guest's name is text somebody typed.

**移出 is confirmed by arming the button, not by a nested modal** — a second Bootstrap dialog over this
one traps focus badly on a phone, the same reason 删除用户 arms in the user modal. `armed` holds one id
and the whole list is redrawn from it, so arming a second row disarms the first; the warning says the
thing an admin actually needs to know, that the row is deleted and the way back is to add the guest
again.

In the sidebar the block sits under the roster and the waitlist (`.guest-block`, reusing `.roster-head`)
and holds **both lists, 名单 then 候补**, under one count. It is a list, not the roster's avatar grid:
a guest has no account and so no picture. One `guestRow` helper renders both halves so they read as one
column, and it carries **no 名单/候补 of its own** — the `.guest-sub-head` above it already says which
list this is, and repeating it per row cost a third of the width in a ~300px sidebar. Only the *second*
`.guest-section-sm` takes the dashed rule (`.guest-section-sm + .guest-section-sm`), so whichever list is
rendered first runs straight on from the head instead of stranding a rule under it. Nothing in the block
is actionable — 添加/移出 live in the admin's dialog.

**The list is ordered oldest-added first** — `getEventGuests`'s `ORDER BY approved_at, requested_at,
id`, so the sidebar list and the admin dialog cannot disagree about it. The old two-part ordering (已批准
before 待批准, and 试训 ahead of Guest inside the pending half, because a hand-reviewed queue of three
places wanted the trialists at the top) went with the queue it ordered. It changes **nothing about
自动分队** — `eventGuests` re-sorts into 申请时间 order itself, exactly so that the display order cannot
reach the teams.

**The two kinds are told apart by the chip's colour, not only its text**: `.guest-type.is-trial` is
amber (the calendar's locked-event amber) and semibold, an ordinary Guest keeps a plain grey chip.
Same size and same position in the row either way, so the list still reads as one column. `guestView`
hangs **`isTrial`** off every row for it — a flag, not a `type === 'TRIAL'` in two renderers — since the
sidebar's EJS and the dialog's `row()` both pick the class from it.

The block is rendered **only when there is something in it**, the same test the waitlist uses. An event
with no 试训/Guest at all is the ordinary case, and a heading over an empty list said nothing the 0 / 3
note in the action stack does not.

`.guest-review-body` (in the dialog, not the sidebar) carries `flex-basis: 0` **deliberately** — with
`auto`, `flex-wrap: wrap` weighs it at max-content and drops the action button onto its own line as soon
as the 由 X 提交 · Y 添加于 … line gets long.

**The teams are shown above the roster, and only to somebody who has checked in.** The block is the
first thing in the `col-md-4` column, before 报名名单: once a member is at the pitch, who they are playing
with matters more than who signed up. Checking in is the price of seeing it, and this is the **one**
thing on the page **an admin does not see by right** — `seesTeams` deliberately has no `ADMIN` branch:
an admin who is playing checks in like everybody else (or is checked in through 代签到), and one who is
not has no team to read. `/event/:id` decides this once (`seesTeams`) and hands the template two locals:
`teams` — `event.teamCount` rows of `{no, members:[{name, isMe, isGuest}]}`, or **null** when there is
nothing to show (nobody allocated, or the viewer hasn't earned it), so the template has one test — and
`teamsLocked`, true only
when teams exist but this viewer may not see them, which renders 签到后可查看分队 instead of an
unexplained gap. `toParticipant` carries `team` for both.

A team is named by its **mark alone** — ♠️ ♥️ ♣️ ♦️ 🪑, per the 队伍数量 table above — because that is
how they are called out on the pitch; the text label rides in a `.sr-only` span beside it. `TEAM_MARKS`
in [event.ejs](views/event.ejs) is a map **keyed by `event.teamCount`**, so a fifth mark or a new layout
means adding to it *and* to `db.TEAM_COUNTS` (and to the schema's CHECK). An unknown count falls back to
the bare number rather than crashing the page.

**The playing teams always render**, an empty one saying 无 rather than vanishing, so the block does not
change shape as members arrive; the **板凳 row appears only once somebody is on it**, since an empty
bench just means nobody overflowed — a 试训/Guest counts, so one guest and no members still raises it.
That exception is the **3-team layout's alone** (`benchNo` in `/event/:id` is 3 there and 0 otherwise):
in the 2- and 4-team layouts the last team is a real side that happens to also be the overflow, so it
renders like the rest. The filter is the route's, not the template's — the
template renders the rows it is given.

**Each row is counted, and the heading says the size once**: the block's head reads 分队（每队 3 人）and
every row reads ♠️（2/3人）：names — both halves out of `event.teamSizes`, which is why the heading drops
the parenthetical and the row falls back to a bare 目前几人 when it is null (an event with nobody on it,
which this block cannot be showing anyway). **The row's right-hand number is that team's own**, so the
teams carrying the remainder read one higher than the rest; the heading, having room for one figure,
states it when every team agrees and the **span** (每队2-3人) when they do not — `low`/`high` off the same
array, not a second rule. **目前几人 counts a 试训/Guest place like a member**, since it
holds a place at the event exactly as one does. **The right half is the size the teams are filled to, not
a maximum** — the last team is the overflow and is uncapped, and nobody is ever re-allocated when the
size moves — so `3/2人` is a legitimate reading, not a bug. The mark and the count are one `.team-head`
flex item so the count can never wrap away from its team; the names are the half that wraps
(`min-width: 0`). The row's `gap` is `.25rem` rather than `.5rem` because the count ends in a
full-width 「：」 that carries space of its own.

**A guest rides in `members` like anybody else, last in its team.** The route appends
`event.guests` after the team's members with `name: g.name + '（' + guestTypeLabel(g.type) + '）'` — that
string is written in `/event/:id`, since 试训/Guest is UI text and db.js stores the keyword — and
`isGuest`, which the template turns into `.team-name.is-guest`: softened to `--gsf-ink-soft`, the same
treatment the waitlist gets on the roster grid. The type suffix is what the softening alone could not
do once guests carry **real names**: 张三（试训） cannot be mistaken for a member at a glance, where a
bare 张三 could. Sorting them last is deliberate — they came in through somebody else, and a member
scanning the list for their own name should not have to read past them.

**The viewer's own name is a tinted chip** (`.team-name.is-me`, `--gsf-100` behind `--gsf-700`) — which
team am I in is the question the block exists to answer, and it is read outdoors on a phone by somebody
scanning for one word, so it is louder than bold alone. That is why each name is **its own span** joined
by a written separator instead of one `names.join(', ')` string; the separator is emitted inline, on one
line, or EJS's newlines land in front of every comma. `isMe` is matched on **email**, never on the name —
two members can share one — and a `.sr-only` （你） carries the same fact to a screen reader. `.team-row` in [event.css](public/css/event.css) is a flex line of mark + names where **only the
names wrap** (`min-width: 0`), so the three marks stay aligned down the column however long a team gets,
in the ~300px sidebar and full width on a phone alike.

**Waitlist.** `event_signups.status` is `SIGNED_UP` or `WAITLIST`, constrained by a CHECK and mirrored by
`db.SIGNED_UP`/`db.WAITLIST`. Signing up for a full event is never refused: `signUpForEvent` counts the
places under the lock and records a `WAITLIST` row instead, and the route redirects to
`?joined=waitlist` so the page can say so. `promoteFromWaitlist` is the only way back up, and it is
called from **every path that can free a place**: a withdrawal (`withdrawFromEvent`, and only when the
leaver held a confirmed place), an admin 移出-ing a confirmed 试训 (`removeEventGuest`), 清空报名
(`clearEventRoster`), an admin raising `capacity` (`updateEvent`, in the same transaction as the edit),
and a member being deleted (`deleteUser`). A new path that frees a place must call it too, holding the
event lock. `promoted_at` records the moment and stays NULL for a row that was confirmed from the start.
Lowering `capacity` deliberately demotes **nobody**: a confirmed place is never taken back, so the event
just sits over capacity until enough members withdraw.

**There is one queue, not two.** 总人数 counts a 试训 exactly like a member, so `event_guests` carries
the **same** `status`/`promoted_at` pair as `event_signups` and a guest either holds one of
the event's places or queues for one beside the members. `promoteFromWaitlist` therefore serves a
`UNION ALL` of the two tables ordered by **when each row took its place in line** — `signed_up_at` for a
signup, `approved_at` for a guest (the moment an admin added them, which is that guest's 报名时间) —
cut to the room available in one SELECT, with the two UPDATEs keyed by exactly the rows it returned. The
ordering is the database's, so who is next cannot be made stale by a concurrent write; it returns
`[{kind, email, guestId}]` rather than the bare emails it used to, and nothing reads that but the caller
that logs it. The two halves are still *shown* in two lists (the roster is an avatar grid and a guest
has no account, so no picture), which is why `queuePlaces(event)` in [server.js](server.js) numbers them
**across both** — two lists each counting from 1 would have two different people believing they are
next. Both `/event/:id` and `guestPayload` go through it, so the page and the admin dialog cannot
disagree about the queue.

**Calendar view.** `/calendar` renders a month grid built server-side by `buildMonthGrid` in
[server.js](server.js#L118): weeks start on **Sunday** (leftmost column), always 6 rows so the card keeps
a constant height while paging, and the leading/trailing cells come from the neighbouring months. The
month shown comes from `?month=YYYY-MM` (anything malformed falls back to the current month). All the
date arithmetic uses local-time `new Date(y, m, d)` — never `new Date('YYYY-MM-DD')`, which parses as
UTC and lands a day early west of Greenwich. Styling lives in [public/css/calendar.css](public/css/calendar.css)
on the brand tokens declared at the top of [public/css/main.css](public/css/main.css); those tokens are
the club blue ramp, and only steps 600+ have enough contrast for text on white.

The grid **is** the page: there is no list of upcoming/past events any more, and
[header.ejs](views/partials/header.ejs) special-cases `path === '/calendar'` to put `.page-full` on
`<body>` and swap the wrapper to `.container-fluid`. The `.page-full` rules in calendar.css pin the body
to the viewport (`overflow:hidden`), hide the site footer, and make `.main-content → .cal → .cal-grid →
.cal-week` a flex chain — every link of it needs `min-height: 0`, or the rows refuse to shrink and the
sixth week is pushed off the bottom instead of the rows sharing the height. `.cal-day` therefore drops
its `min-height` on this page and scrolls internally when a day holds more chips than fit.

**Creating and editing events.** One form serves both: [views/partials/event-modal.ejs](views/partials/event-modal.ejs)
holds the markup *and* its script, and each page includes it with a `formEvent` local — `null` from the
"添加活动" button on `/calendar` (POSTs to `/api/events`, `requireAdminApi` → `db.createEvent`, which
generates the 24-char hex id), the event itself from the "编辑" button on `/event/:id` (pre-filled, PUTs
to `/api/events/:id`). Both buttons render only for admins. Change the form once, in the partial; the
including page supplies `formEvent`, `mapCenter` and `defaultDate`, nothing else.

**`formEvent` decides what the modal *can* do; `data-event-modal` on the button decides what it does on
this click.** The script holds a `MODES` map — `create` always, plus `edit` and `copy` when `formEvent`
is set — and each mode carries its endpoint, method, title, submit label and where to go afterwards
(`reload` the event page, `/event/<new id>` for a copy, `/calendar?month=…&created=1` for a creation).
A button opening the modal names its mode (`data-event-modal="edit"` / `"copy"`); one without the
attribute, like 添加活动 on `/calendar`, leaves the render-time mode alone. The listeners are bound to
the buttons themselves, not to `document`, so they run before Bootstrap's data-api handler shows the
dialog and the title is already right when it appears. `setMode` calls `form.reset()`, which restores
every field to the value the server rendered — that *is* the prefill for a copy, so only the date is
then moved on a week (`addWeek`, local-time arithmetic, same reason as the calendar grid). It also
means switching modes never leaves a cancelled copy's edits in the 编辑 form. Any new field that
needs a mode-specific value goes in `setMode`, after the reset.

The modal carries a Leaflet picker — click the map or drag the pin to set `coords`, drag the green dot on
the rim of the radius circle to resize it, plus lat/lng/`checkinRadius` boxes that stay in sync both ways —
and clearing lat/lng sends `coords: null`, i.e. an online event with no check-in. The rim handle keeps its
last bearing (`handleBearing`) so it stays where it was dropped, and writes `radiusInput.value` directly
during the drag: setting `.value` fires no `input` event, which is what stops `drawPoint` from repositioning
the handle out from under the cursor. **There is no separate search box: the 地点 field is the geocoder
input**, hitting **Nominatim** (`nominatim.openstreetmap.org/search`, same project as the tiles, no API
key). Picking a result fills 地点 and moves the pin — unconditionally, since the member picked it; the
value written is `placeLabel()`, the place's name plus the two components after it, because
`display_name` is the whole postal chain down to "United States" and unreadable in a form field (the
list still shows the full string, which is what makes two same-named parks distinguishable). It runs as
you type, 300ms after the last keystroke — note that Nominatim's policy for the public instance actually
**forbids autocomplete** and caps it at a request a second, so the guards are load-bearing: a 2-character
minimum, the same trimmed text is never queried twice in a row, and each request aborts the one before
it. A sequence number, not the abort, is what stops a slow earlier reply overwriting a later one. Enter
passes `force` to re-run a query the debounce would skip, and is `preventDefault`ed because the box lives
inside the event form. Swapping to a geocoder built for type-ahead (Photon, LocationIQ) is a change of URL
and result-field names only. 地点 is still an ordinary free-text field, so `blur` closes the list —
paired with a `mousedown` `preventDefault` on the list, without which Safari (which doesn't focus a button
on click) would tear it down before the click landed. The results list is in normal flow, not an absolute
dropdown: the modal body is a scroll container and would clip an overlay. It is a **sibling** of the
`.field-inline-sm` wrapper around label+input, not a child — under `sm` that class makes its children one
flex row and the list would join the line.

**总人数 shares its `col-sm-6` row with 队伍数量**, the two halves of one decision — how many places
there are, and how many ways they are split. 队伍数量 is a `<select>` of 2/3/4 carrying `selected` in
the **markup**, not from script — `form.reset()` in `setMode` is what restores the prefill, so a 复制
keeps the original's team count. 地点 still has the
whole width to itself, which is what gives the geocoder's results list room.

**开始时间 and 结束时间 are two `datetime-local` inputs that need no conversion at all.** `start_at` and
`end_at` are stored in exactly the form the control carries — `'YYYY-MM-DDTHH:MM'` — so the EJS preamble
drops them straight into `value=` and the submit handler sends them back as `startAt`/`endAt` with only a
`slice(0, 16)` to trim the `:00` seconds some browsers append. Nothing is stitched or parsed on the way
through, and `date`/`time` are derived server-side, so they are not in the body. The pair sits in one
`form-row`, `col-sm-6` each: side by side from `sm` up, stacked on a phone where `.field-inline-sm` puts
each label on its input's line, keeping it two rows rather than four.

**结束时间 trails 开始时间 by `DEFAULT_HOURS` (2) until it is set by hand.** `syncEnd` has no "touched"
flag — the end counts as the automatic one exactly while it equals `addHours(lastStart, DEFAULT_HOURS)`,
where `lastStart` is the start the current value was derived from, so a hand-set end survives however
many times the start is nudged afterwards. The one override is a start pushed to or past its own end,
which nothing could save: that snaps back to the default rather than raising an error the admin has to
fix. `addHours` is local-time `new Date(y, m, d, h + n, min)` arithmetic like `addWeek` — an evening
kick-off plus two hours is legitimately the next day, and `end_at` carrying a different date to
`start_at` is normal, not an error. It is bound to both `input` (fires per segment while typing, and the
value reads `''` until every segment is filled — hence the `DT_RE` guard) and `change` (the native
calendar). `setMode` resets `lastStart` after `form.reset()`, and a copy moves **both** ends on by a
week so the event keeps its length.

The modal is `modal-dialog-scrollable`, but Bootstrap's rules for that put `max-height`/`overflow:hidden` on
`.modal-content` and `overflow-y:auto` on `.modal-body`, and the `<form>` in between is the actual flex item.
[calendar.css](public/css/calendar.css) gives that form `display:flex; flex-direction:column; min-height:0;
overflow:hidden` to join the two halves up — without `min-height:0` it refuses to shrink and the content
simply clips the footer instead of the body scrolling. Any new element wrapped around the body needs the
same treatment. `mapCenter` is the latest
event with coords on `/calendar` and the event's own point on `/event/:id`, both falling back to
`DEFAULT_MAP_CENTER`. The map is built on Bootstrap's `shown.bs.modal`, because Leaflet measures a
`display:none` container as 0×0; that handler waits for `window.load` since jQuery only loads in the
footer. **`leaflet.js` is loaded once, in [views/partials/header.ejs](views/partials/header.ejs)** — an
admin viewing an event has the check-in map and the picker on one page, and a second copy of the library
would swap `L` out from under whichever map was built first. It is deliberately not `defer`red: the
inline map scripts run during parsing.

Creating navigates to `/calendar?month=<new event's month>&created=1`, and that flag is what renders the
green banner the page's script removes after 5 seconds; editing just reloads the event page. Either way
the result comes from one fresh server render instead of being patched into the DOM. `validateEvent` is
shared by both routes; extend it rather than adding a second set of checks.

**The roster head states 总人数, not just the members.** `已报名人数：N 人 · 试训 G 人` on the first
line and `总人数 T / capacity · 剩余 R 个名额` on the second (`.roster-total`, smaller and softer) — the
members' number alone could never say how much room is left once a 试训 holds a place, and 剩余名额 is
the half somebody deciding whether to sign up is actually reading. The 试训 clause only renders when
there is one. The signup button keys off `full` (`event.placesLeft <= 0`), not a members-only count, so
加入候补名单 appears at the moment the event really is full.

**Signup roster.** The 报名名单 block is an avatar grid (`.roster` in [public/css/event.css](public/css/event.css)),
not a list: each member is their `profilePhoto` — or the gravatar fallback — over their name, and the
grid is `repeat(auto-fill, minmax(4rem, 1fr))` so the same markup fills a phone screen and the narrow
`col-md-4` sidebar without a breakpoint. A check-in renders as a green ring plus a tick badge on the
avatar (with a legend under the grid) rather than a per-row 已签到 label. There is deliberately **no
card around it**: the border plus `.card-body` padding cost roughly a whole column of avatars in that
sidebar, so the count is a plain `.roster-head` with a hairline under it. The `<img>` is `object-fit:
cover` because a stored `profile_photo` is an arbitrary URL at an arbitrary aspect ratio, unlike the
square gravatar; the gravatar fallback is requested at `s=144` for a 48px box, i.e. sized for a 2–3×
phone screen, so changing the CSS size means revisiting that number in `/event/:id` **and** the
`width`/`height` attributes on the `<img>` in [views/event.ejs](views/event.ejs). The grid has room for
a name and nothing else, so the two timestamps ride in the `title` tooltip — `server.js`'s `formatStamp`
renders them (club-local, `m/dd/yy HH:MM`, see below) and the template never sees a raw `Date`.

**候补名单 is a second copy of that grid**, below the roster and rendered only when somebody is waiting.
Same markup, three differences: the avatar is dimmed (`.is-waitlisted`, `opacity` on the `<img>` alone so
the badge and name keep their contrast), the tick badge's corner carries `.roster-queue` — the member's
1-based place in the queue — and the whole thing is skipped when `waitlist` is empty. `/event/:id` builds
both grids from `event.roster` with one `toParticipant` mapper, so a field added for one is in the other.
The signup button reads the viewer's own row: 报名 when there is room, **加入候补名单** (`btn-warning`)
when there is not, 退出候补 with their place when they are already waiting, 取消报名 when confirmed —
all four posting to the same two routes, since `withdraw` deletes whichever kind of signup you hold.
**A checked-in member gets no button at all**, only the note (✓ 你已报名，… 已签到，不能取消报名) —
arriving is final, see below.

**Event page actions.** Everything the page can do is one divider-separated stack of full-width buttons
(`.event-actions` in [public/css/event.css](public/css/event.css)), mirroring the production app:
报名/取消报名 for everyone, then 编辑活动, 清空报名, 复制 and 删除活动 for admins only. The title row
carries no buttons. The stack sits **outside and after the `.row`**, not inside the `col-md-8` details
column, so it lands below the roster in both layouts — details beside the roster on `md+`, then
details → roster → buttons stacked on a phone. Moving it back into a column puts the buttons above the
roster on a phone. 清空报名 is a plain form POST gated by `requireAdmin` (the
HTML guard, which re-reads the role), not by `isAdmin` in the template — that local only decides what
renders — and confirmed with an inline `onsubmit` `confirm()`. `POST /event/:id/clear-signups` calls
`db.clearEventRoster`, which drops the waitlist and the check-ins along with the signups: a check-in
from someone off the roster means nothing, and a queue with nobody ahead of it is noise.

**A finished event is frozen: 编辑活动, 清空报名 and 删除活动 all disappear once `hasEnded(event)`**, the
same instant that raises 已结束 and closes the check-in — a past event is the club's record of who signed
up and who turned up, so nothing may still rewrite or destroy it. Each of the three routes enforces it
itself, since the template only decides what renders: `PUT /api/events/:id` answers **400**, not the 404
a hidden event answers (it exists and can still be read — and that 400 is also what stops a member
raising `capacity` to promote themselves off a past event's waitlist), while the two HTML POSTs
(`clear-signups`, `delete`) re-read the event and redirect back to it unchanged. **复制 deliberately
stays** — copying a past event onto next week is how the next one is made, and it POSTs a *new* event
rather than touching this one, which is why `event-modal.ejs` is still included on a finished event
(nothing opens it in `edit` mode there) while `#delete-event-modal` is not rendered at all. The corollary:
an event created with an already-past date can only be corrected in SQL. A new admin action that mutates
an existing event needs the same `hasEnded` gate.

**复制 has no route of its own.** It opens the same event modal in `copy` mode — every field prefilled
from this event, the date a week on, editable before it is saved — so the copy is an ordinary
`POST /api/events` (`requireAdminApi`) landing on the new event page. The copy starts with a fresh id and
an empty roster because `createEvent` only writes the event row; the roster is not part of the form.
The old `POST /event/:id/copy-next-week` route and the server's `addDays` helper are gone with it, as
is the `nextWeekDate` render local.

**删除活动 is the one destructive action confirmed in a modal, not an `onsubmit` `confirm()`.**
`#delete-event-modal` lives at the bottom of [views/event.ejs](views/event.ejs) beside the event modal
and renders only for admins; it needs no script, because the dialog *is* the confirmation — its 确认删除
button is inside the `<form>` that POSTs to `/event/:id/delete` (`requireAdmin`, which re-reads the
role). 清空报名 keeps its native `confirm()`; deleting takes the whole event with it, and a phone's
one-line native dialog has no room to say what is lost. That form is a flex item in `.modal-footer`, so
`event.css` gives **the form** the full-width treatment members.css only applies to direct `.btn`
children below `sm` — a new footer button wrapped in a form needs the same.

`db.deleteEvent` is a single `DELETE … RETURNING *`: unlike `deleteUser`, `event_signups` and
`event_checkins` really do carry `REFERENCES gsffc.events(id) ON DELETE CASCADE`, so there is nothing to
cascade by hand and no waitlist left to promote. It returns the deleted event so the route knows which
month to send the admin back to — `/calendar?month=…&deleted=1`, the mirror of `?created=1`, raising the
same banner in red (`.flash-banner.is-removed`) through the same 5-second script. A second delete of the
same id returns `null` and the route answers 404.

**Check-in flow.** Browser `watchPosition` → `POST /event/:id/checkin` with `{lat, lng}` →
server recomputes haversine distance against `event.coords` and rejects beyond `event.checkinRadius`.
The identical `distanceMeters` helper exists twice, in [server.js](server.js#L97) and inline in
[views/event.ejs](views/event.ejs#L180); the client copy only enables/disables the button — the server
copy is authoritative. What the server accepts is written by `db.checkInToEvent` as an `event_checkins`
row: the time, plus the coordinates and the distance it just computed, as the evidence behind it.
Checking in twice keeps the first row, so `checked_in_at` is always the moment of arrival. The route
reads the member's own `event.roster` entry, so a **waitlisted** member is refused (there is no place to
arrive at yet) as distinctly from one who never signed up.

**Arriving is final: once a member has checked in they can no longer 取消报名.** The check-in is the
event's record that they turned up — the moment, the distance, their 分队 and their line in 罚款统计 —
and a withdrawal used to delete that row along with the signup, i.e. a member could erase their own $10
by tapping 取消报名 after the fact. `withdrawFromEvent` now **refuses** instead: it reads the check-in
row first and answers `{removed: false, checkedIn: true}` without touching anything. That read is inside
`withEventLock` and `checkInToEvent` holds the same lock, so a check-in racing a withdrawal is
serialised and cannot slip in behind the guard. Because nothing checked-in can be withdrawn any more,
the function no longer deletes `event_checkins` rows at all. The event page renders no button for such
a member (only the note), and the route redirects a hand-crafted POST back to the event unchanged — the
same shape as the frozen 清空报名. The ways out of a checked-in signup are the admin's 清空报名 and SQL;
a member who checked in by mistake needs one of them. `deleteUser` and `clearEventRoster` are untouched
and still drop check-ins.

**代签到 is the same check-in with a different hand on the phone.** `POST /event/:id/checkin-for`
(`requireAdminApi`, body `{email, lat, lng}`) is how an admin standing at the pitch checks in a member
who can't do it themselves — a dead phone, no signal, no app. It is deliberately **not** a way around
the geofence: `atTheField(event, body)` in [server.js](server.js#L248) holds the window gate, the
coordinate parse and the radius test, and **both** check-in routes go through it, so the proxy path
cannot quietly become the looser one. What it measures is the **admin's** position — they are the one
who is actually there — and that is what lands in the row's `lat`/`lng`/`distance_m`. The rest of the
gates are the member's: on the roster, `SIGNED_UP` (a waitlisted member is refused, as distinctly as one
who never signed up), not already checked in.

`event_checkins.checked_in_by` is what makes the row different, and it is now written: the admin's
address, NULL for an ordinary self check-in — so a non-null value **is** the "this was a proxy" flag,
which is why `db.checkInToEvent` drops a `by` equal to the member's own email rather than storing it.
It carries no foreign key, for the same reason `event_checkins.email` doesn't. Fines are untouched:
`lateness` reads `checked_in_at` alone, so a member checked in late by an admin owes exactly what they
would have owed.

In the UI it is a 代签到 button at the head of the admin action stack, rendered from `proxyTargets`
(confirmed members with no check-in, empty unless `isAdmin && !isPast && event.coords`) — so it
disappears once everybody has arrived — and shown **only while the check-in window is open**. That last
gate is the newer one and it reversed an earlier choice: the button used to be offered whatever the
window said, on the reasoning that the dialog was where "签到尚未开放" belonged. It isn't, because 代签到
is something an admin does *standing at the pitch*: before the window opens there is nothing they could
be doing with it, and the button led only to a dialog explaining that.

**The row is `d-none`, not absent, when the window has not opened yet**, and a `setTimeout` at the head
of the block's own script clears the class at `OPENS_AT` — the window routinely opens while an admin
already has the page up, and making them reload for it would be the one thing this page never asks
anywhere else. Same shape as the status badge's timer: one timeout aimed at the instant rather than a
ticking interval, clamped to 2147483647 because `setTimeout` overflows past ~24.8 days, re-read on
`visibilitychange`/`pageshow`/`focus` because a backgrounded phone may never fire it, and measured
against the server's clock via `SKEW`. The dialog keeps its own 签到尚未开放 branch as the backstop for
the second or so between the reveal and the server's own view of the clock.

`#proxy-checkin-modal` carries **its own** `watchPosition`, alive only while it is open: the
check-in button's script exists solely for a signed-up member who still has to arrive, and an admin
doing this may have checked in already or not be playing at all. It has no map — the distance readout
is what the admin needs. One `render()` writes the status line and the button's disabled state, exactly
as on the check-in button, and a 1s ticker covers the window opening or closing while it sits there.
A success **keeps the dialog open** minus the member just done (an admin at the pitch is usually doing
several), and `hidden.bs.modal` reloads the page if anything changed rather than patching the stale
roster behind it.

On the roster the proxy check-in renders as a 代 in a blue circle followed by the admin's name, and it
rides **under** the avatar at its left edge rather than in a corner of it: both corners are already
spoken for (a proxy check-in is still a check-in, so it always carries the tick or the fine), and this
mark has a name attached rather than being a glyph. `.roster-proxy` is an in-flow child of the 48px
`.roster-avatar` — which is why that box now has an explicit `width` — so `max-width: 100%` is what caps
the strip at the avatar's width; the circle holds its size (`flex: none`) and the name is the half that
ellipsises, so no name can ever widen the grid column. Blue, because it says *how* the check-in
happened, not whether it counts. The full name is in the `title` tooltip and in a `.sr-only` span, and
`.roster-proxy-mark` is reused inline in the legend (hence `inline-flex`).

**The check-in window opens an hour before kick-off** (`CHECKIN_LEAD_MS`) and closes when the event
ends. `checkinOpensAt(event)` is that first instant and both the route and the page use it, so the
button and the server agree on when it opens; `hasEnded(event)` closes it. A malformed `startAt` makes
`checkinOpensAt` `NaN`, and both gates then fall back to distance alone.

**迟到罚款 is derived, never stored.** Nothing about a fine is written to the database: `lateness(event,
checkedInAt, ended)` in [server.js](server.js#L248) computes it on every render from `checked_in_at`
against `clubEpoch(event.startAt)`, so correcting an event's start time re-prices its fines and no
column can drift out of agreement with the times it was calculated from. It answers `{fine, lateMs}` —
`fine` in whole dollars (0, `FINE_LATE` 5, `FINE_VERY_LATE` 10), `lateMs` null when there is no lateness
to name — and `/event/:id` hangs `fine`/`lateLabel` off each participant. The thresholds:

- **`FINE_GRACE_MS` (59s) is what makes the rule expressible at all.** `start_at` is a wall clock with no
  seconds, but `checked_in_at` is a real timestamp that has them, so "on time" has to be a span rather
  than an instant: anything inside the starting minute counts as punctual (for a 19:50 kick-off, up to
  19:50:58). The club states it as "19:50:59 前签到都不算迟到".
- Past that there is one boundary, **`FINE_TIER_MS` (5 minutes) after kick-off, and that instant is still
  the cheaper side of it** (`late <= FINE_TIER_MS`): ≤5 min late is $5, beyond it $10.
- **Absence costs the same as the far tier**, which is why both are `FINE_VERY_LATE` — but only once the
  event is over. `lateness` takes `ended` (the route's `hasEnded`) for exactly that: before the end a
  member who has not checked in has simply not arrived yet, and fining them would be a live accusation
  that the next minute could withdraw.
- A **waitlisted** member is outside the rules entirely — they were never due at the event — so
  `toParticipant` only calls `lateness` for a `SIGNED_UP` row. An unparseable `startAt` fines nobody, the
  same fallback the check-in gates take.

In the UI a fine **replaces** the green check rather than joining it: the avatar's ring turns red and the
tick badge's slot carries `.roster-fine`, the amount as dollar signs (one for $5, two for $10 — red signs
on white, since a glyph knocked out of a solid red badge is much harder to *count* at 10px, and the count
is the whole message). A member who merely hasn't checked in keeps the plain avatar; they are named in
the 罚款统计 panel instead, which is where absence is stated. The `title` tooltip carries the amount and
how late (`lateLabel`).

**罚款统计 exists only on a finished event.** `/event/:id` passes `fines` as null until `hasEnded`, since
nothing is settled while somebody can still turn up — one test for the template rather than a length
check per tier. Both tiers always render, an empty one saying 无, so "nobody owes $10" is stated rather
than implied. The panel sits in the `col-md-8` details column, not under the roster: on a phone that puts
the tally of a finished event immediately after its details (details → 罚款 → 名单 → 按钮). A new tier
means adding to the array `/event/:id` builds and to the note under the panel — the amounts are not
otherwise hardcoded in the template.

**One timezone, named once.** `start_at`/`end_at` are naive wall clocks and the process runs in **UTC**
on Netlify, so turning one into an instant needs a zone: `CLUB_TIMEZONE` (env, default
`America/Los_Angeles`). **Set it if the club is not in California** — check-in windows and 已结束 would
otherwise be hours off. `zoneOffset(epoch)` asks `Intl` for the offset *at that instant*, which is what
makes everything below DST-aware rather than a fixed number, and three helpers are built on it:
`clubEpoch(wall)` (wall clock → epoch, looking the offset up twice because it depends on the very
instant being solved for, so a DST boundary lands right), `todayStr()` (today's YYYY-MM-DD in the club's
zone) and `formatStamp()` (a real `TIMESTAMPTZ` → club-local text). **Nothing may go back to
`new Date().toISOString().slice(0,10)` for "today", or to `getHours()`/`getMonth()` for display.** Both
read the *process's* zone: `toISOString` is UTC, so after 17:00 in California "today" was already
tomorrow and an event hours away was rendered 已结束 — and on Netlify a 22:23 check-in was shown to the
member as 05:23. The calendar route derives its current year/month from `todayStr()` for the same
reason (in UTC, a December evening in California is next January).

**One display format for a date and time: `m/dd/yy HH:MM`** — month unpadded, day padded, two-digit
year, 24-hour clock (`8/12/26 23:04`). It is short enough for a phone, which is what the whole page is
sized for. `formatStamp` emits it for real timestamps, and `event.ejs`'s `mdy` helper slices it out of
the `'YYYY-MM-DDTHH:MM'` wall clocks for the 时间 row; **an end on the same day as the start shows only
its clock** (`8/12/26 21:00 - 23:04`), and repeats the date only when the event runs past midnight. This
is the display shape only — stored values, the JSON API and the `datetime-local` inputs all stay
`YYYY-MM-DDTHH:MM`, and `event.date`/`todayStr()` stay `YYYY-MM-DD` because they are *compared*
lexically, not read. `users.joined` is free-text TEXT and is rendered as stored.

The button has three gates and one renderer. `render()` in [views/event.ejs](views/event.ejs)
is the only thing that writes `disabled`, the pulse class or the hint beside it, and it is called from
the 1-second ticker, from every position fix, on every return to the page and after a failed POST —
never from two places at once. Its states are: after `CLOSES_AT`, disabled with 活动已结束（a
`setTimeout` armed at that instant closes the button on an event that ends while the page sits open,
rather than leaving one the route answers 400 to); before the window, disabled with a live countdown;
open but outside the radius (or with no fix yet), disabled with 到达球场后即可签到; open and inside,
enabled with the `is-ready` pulse; and past kick-off, urgent (below). A `submitting` flag keeps it from
re-enabling the button under an in-flight request. Times are compared against the server's clock, not
the phone's: `SKEW` is the difference measured at render, so a phone running fast can't be shown a
button the route will refuse.

**The ticker runs two countdowns back to back, and `STARTS_AT` — not `OPENS_AT` — is where it ends.**
Once the window opens the countdown doesn't stop, it switches to counting down to kick-off, appended to
whatever the position gate is saying (`到达球场后即可签到 · 距活动开始 00:24:57`). `startTicker` is
therefore bounded by `STARTS_AT`; past it the hint is a fixed sentence and position fixes drive the
rest. `STARTS_AT` (`eventStartsAt`, `clubEpoch(event.startAt)`) **gates nothing** — check-in stays open
past kick-off, which is the whole point of the fines — it only decides what the page *says*.

**Past kick-off, an unchecked-in member gets the urgent button:** `setUrgent(true)` swaps `btn-success`
for `btn-warning` and adds `is-urgent`, which repoints the pulse at `checkin-pulse-urgent` — amber, and
**1.2s against the calm state's 1.8s, i.e. 50% faster**. Colour and pulse are one switch so they cannot
disagree. The hint becomes 活动已开始，请赶快到场签到。不签到均按缺席处理。 — deliberately the same
sentence whether or not the member is inside the circle, since the enabled amber button is what says
they can act now. The server-rendered markup carries the urgent classes too when the event is already
under way at load, or the page flashes a calm green button before the script's first `render()`.

**The status badge beside the title changes three times on its own** — 签到已开放 (`badge-success`) when
the window opens, 活动已开始 (`badge-warning`) at kick-off, 已结束 (`badge-secondary`) at the end, and
nothing before any of that. It belongs to **everyone looking at the page** — a member who has already
checked in, one who never signed up, an admin — so it has **its own script**, not a branch of the
check-in one, which only exists for a signed-up member who still has to arrive. That script is one
`setTimeout` aimed at the next transition rather than a ticking interval (a badge that changes three
times in an event's life does not need a second-by-second loop), clamped to 2147483647 because
`setTimeout` overflows past ~24.8 days and a distant event would otherwise fire immediately; it re-reads
the clock on `visibilitychange`/`pageshow`/`focus` for the same backgrounding reason the button does. It
is skipped entirely on a finished event and on one with an unparseable time, where the server's badge is
the best answer there is. The element renders empty with `d-none` rather than being absent, because the
script needs something to move on. A fourth state means adding to *both* the EJS `status` ternary and
the script's `apply()`.

**Everything on that page is built to survive the phone backgrounding it**, which is what a member
actually does between arriving and checking in. Chrome on Android throttles a hidden tab's timers to
about one a minute and stops them entirely after a few minutes, and it can stop servicing
`watchPosition` without ever raising an error — so the countdown froze mid-number and the button stayed
disabled after the member walked into the circle. Three things fix it, and a change to any of them has
to keep all three:

- **The countdown is a self-rescheduling `setTimeout`, not `setInterval`.** Each tick re-reads the
  corrected clock and aims at the next whole second of it, so a page frozen for ten minutes resumes on
  the right second instead of ten minutes' worth of missed ticks behind. `render()` never counts ticks;
  it only ever subtracts `now()` from an absolute instant, which is what makes that safe.
- **`resync()` runs on `visibilitychange`, `pageshow`, `focus` and `online`** — every way the page can
  come back in front of the member. It re-renders from the clock, restarts the ticker, tears the
  geolocation watch down and starts a **new** one (a watch that survived the background often survives
  it silently: still registered, no longer delivering) and asks for a fix immediately. The watch rebuild
  is throttled to once a second, because `focus` and `visibilitychange` both fire on the way back, and
  `lastResync` is seeded to `Date.now()` so the `pageshow` of the initial load doesn't tear down the
  watch that was just started.
- **A backup poll.** While the page is visible and the newest fix is older than `POSITION_MAX_AGE_MS`
  (20s), `getCurrentPosition({maximumAge: 0})` is called outright. `watchPosition` stays the primary
  source; this is what turns the button on when somebody walks into the circle and the watch has gone
  quiet. Its failures are ignored on purpose — the watch's error handler owns the message, and one
  timed-out poll must not blank a good fix. The line under the map stays a pure distance readout —
whether the button is usable, and why, is the hint. The `is-ready` pulse is an animated `box-shadow`
rather than a scaled pseudo-element, because a shadow paints outside the box without widening it: a
full-width button on a 320px screen would otherwise push the page into horizontal scroll.

**Async errors.** Express 4 doesn't catch rejected promises, so every async route is wrapped in the
`wrap()` helper. New async routes must use it or failures will hang the request.

**Auth.** Session cookie only — no JWTs, no refresh tokens. `requireLogin` redirects HTML routes to
`/login` (storing `returnTo`); `requireLoginApi` returns 401 JSON for `/api/*` and the check-in endpoint.

**Roles.** Two, stored uppercase in `users.role` and constrained by a CHECK: `MEMBER` (the default) and
`ADMIN`. `req.session.user.role` is a copy taken at login and used **only for rendering** (hiding nav
links); it can be 30 days stale, so it is never the authorization check. `requireAdmin` /
`requireAdminApi` (both built by `adminGuard` in [server.js](server.js#L60)) re-read the row from the
database on every admin request and refresh the session copy, so a demotion takes effect at once.
Member-only traffic keeps its current query count. Gate new admin routes with these, never with
`req.session.user.role`.

**User writes go through `db.upsertUser`** ([db.js](db.js#L64)) — insert-or-update-password keyed on
email, writing `name`/`position`/`role` only when supplied, so a password reset never clobbers an
admin's role. That's what makes it serve both the bulk
add form on `/members` and (in future) a member changing their own password: pass just email + password and
the existing profile is preserved. Prefer extending it over adding new user-write SQL. The older
`db.createUser` stays only because `POST /api/users` depends on its duplicate-key 409.

**Member list.** [views/members.ejs](views/members.ejs) + [public/css/members.css](public/css/members.css),
which reuses the `.page-head` / `.card-surface` / `.btn-brand` helpers that happen to live in
`calendar.css` (every stylesheet is loaded on every page). The table is phone-first: `#` drops below
`sm`, 账号 and 加入时间 drop below `md`, and the email is repeated inside the name cell for the widths
where its own column is hidden — so a new column needs a matching `d-none d-*-table-cell` decision.
The row action is an icon-only pencil (`.icon-btn`, 44px on touch screens) because a text button
widened the table past a phone viewport. Both modals stack their footer buttons full-width under `sm`,
and `.modal .form-control` is forced to 16px there: anything smaller makes iOS Safari zoom on focus.

Under `sm`, a form field marked `.field-inline-sm` puts its label on the same line as the input, which
takes roughly a third off the form's height; the rule lives in `calendar.css` and both modals (event
and user) use it, so it is deliberately *not* scoped to an id. A `.form-text` hint inside such a field
is hidden there — it would otherwise land in the middle of that flex row — so the placeholder has to
carry the same information. `.page-head` also shrinks under `sm`, on every page that uses it.

**批量添加会员 posts with `fetch` and never navigates.** `POST /members/add-users` splits the paste on
each line's *first* colon and runs `db.upsertUser` per line — a new address is created with that
password, an existing one keeps its name/position/role and only has its password reset — which is why
it is both the "add members" and the "reset a password" path, and the only way an account is created at
all. It answers `{ok, results}` (one entry per line: the address or the unparsable line, and what
happened to it) under `requireAdminApi`. It used to render `/members` straight out of the POST, which
left the browser on `/members/add-users` and made a refresh re-submit the whole paste; the results are
now drawn into the open modal by its own script. All succeeded → the textarea is cleared and a 5-second
countdown ends in `location.assign('/members')`, one fresh GET, so the new rows appear with the URL and
the history untouched. Anything failed → the paste is left in place to be corrected and nothing
redirects. `renderMembers` therefore takes no `results`/`input` locals any more.

`db.updateUser` is the edit-only counterpart, behind `PUT /api/users/:email` and the per-row
pencil modal on `/members`. It never inserts and needs no password, so a blank password box means
"keep the current one"; `name`/`position`/`profilePhoto` are written only when the key is present, and an
empty `position`/`profilePhoto` string clears the column. It cannot change `role` — promotion is still a
manual SQL update.

**Avatars.** `users.profile_photo` is a TEXT column holding the *URL* of the member's picture (nothing is
uploaded or stored by this app). Every function returning a user row maps it through `rowToUser`, which
renames it to `profilePhoto` — the name the form, the JSON API and the templates all use; `getUserByEmail`
is the exception, it hands back the raw row (it carries `password_hash` too) so `/profile` reads
`row.profile_photo` there. `db.js`'s `normalizePhoto` restricts writes to `http(s)://…` or a site-relative
`/…` path, because the value goes straight into an `<img src>`. Empty means "no photo", and every render
falls back to `gravatar(email)` — so a member without one looks exactly as before. The photo is a URL the
member typed and can 404, so `/profile` also carries the gravatar in `data-fallback` and swaps to it from
`onerror`; `.profile-avatar` is `object-fit: cover`, since the picture won't be square.

**The URL is not typed — it is uploaded.** The edit form's old 头像链接 box is still gone and the modal
still omits `profilePhoto` from the PUT body entirely (`db.updateUser` only writes keys that are present,
so saving the form can never undo an upload). What sets the column is the avatar at the top of
[user-edit-modal.ejs](views/partials/user-edit-modal.ejs) — see 头像上传 below. `PUT /api/users/:email`
still accepts the key and `db.updateUser` still writes it, so an external URL can also be set by hand in
SQL. The pages keep rendering the value and their `data-photo` attributes; every path that changes the
photo dispatches the same `user-updated` event, so the handlers patching the avatar keep working.

**头像上传.** The modal opens on the member's picture with a pencil on its rim: tapping the picture opens
it full size (`target="_blank"`), tapping the pencil opens the file picker and **the upload starts as
soon as a file is chosen** — no confirm step, no save button. The pencil is the progress indicator: three
icons live in the markup at once (pencil / spinner / tick) and `is-uploading`/`is-done` on the button
decide which one shows, so nothing swaps icon classes mid-flight. The green tick **stays** until the
modal is opened again. Its states are set in one place, `setPhotoState`.

- **The picture never leaves the browser at full size.** `squareJpeg` draws the chosen file into a
  canvas — centre-cropped square, at most 512px, JPEG at 0.85 — so a 4MB phone photo arrives as ~30KB,
  and the crop matches the `object-fit: cover` every avatar box uses. The resized blob is POSTed as the
  raw request body (`Content-Type: image/jpeg`); there is no multipart parser and no upload library.
- **`POST /api/users/:email/photo`** (`requireSelfOrAdminApi`, `express.raw`) decides the type from the
  **magic bytes**, not the Content-Type header — the value is handed back to a browser as an image, so
  only something that really is one may be stored. It carries the same rule as the PUT: an `ADMIN` row's
  photo is writable only by that admin, re-read from the database. The modal mirrors it by hiding the
  pencil (rendering only). It answers `{ok, user}`, the same shape the PUT does, and the script
  dispatches `user-updated` with it — which is what patches the profile card, the navbar and the
  including page's `data-photo` without a reload.
- **The bytes live in `gsffc.user_photos`, not in `users`.** Every page that lists members SELECTs
  `users` whole (the event page reads all of them to build the roster), so a base64 picture per row would
  ride along with all of it; `profile_photo` keeps its documented shape and holds
  `/photos/<email>?v=<upload time>` — which `normalizePhoto` accepts unchanged, being site-relative.
  `db.setUserPhoto` writes both in one transaction. `GET /photos/:email` serves the row `immutable`:
  the `?v=` changes on every upload, so a replaced picture is simply never requested again. It answers a
  bare **401** rather than going through `requireLogin` — this is an `<img>` src, and a redirect to
  `/login` would both render as a broken image and leave the picture's URL in `returnTo`.
- This is the **one** table with a foreign key to `users` (`ON DELETE CASCADE`), so `db.deleteUser`'s
  hand-rolled cascade needs no line for it.
- **`serverless-http` must be given `binary: ['image/*']`** ([netlify/functions/server.js](netlify/functions/server.js)):
  Lambda responses are strings and it base64-encodes only what it considers binary — by default nothing,
  which would corrupt every avatar in production while working perfectly in dev. Any future route
  answering with bytes needs its type in that list.

**Deleting a member** is `db.deleteUser`, behind `DELETE /api/users/:email` (`requireAdminApi`, and the
route additionally refuses the session's own email — deleting yourself would destroy the session doing
it and could leave nobody able to manage members). **An `ADMIN` row can never be deleted**: the route
re-reads the target with `db.getUserByEmail` and answers 403 when its role is `ADMIN`, which also covers
the self case. Removing an admin therefore means demoting them to `MEMBER` in SQL first — the same manual
update that promotes. Nothing in `db/schema.sql` points a foreign key at
`users`, so the function does the cascading by hand: in one transaction it deletes the row, then the
member's `event_checkins` and `event_signups` rows (a leftover would render as a raw address on the event
page and still count against capacity) — and because that can free confirmed places, it locks each event
it emptied a place in and runs `promoteFromWaitlist` there before committing. Afterwards it sweeps the
member's `gsffc.session` rows so an already-signed-in browser stops working. That sweep is best-effort — the session table is created lazily
by `connect-pg-simple`, so a failure is logged, not thrown. `/profile` already tolerates the account
vanishing under a live session (it destroys the session and redirects to `/login`).

**Profile page.** The member's name in the navbar links to `/profile`, which renders their own row
(read fresh from the database, not from the session copy) and an "编辑" button opening the *same*
form admins get. That form lives in [views/partials/user-edit-modal.ejs](views/partials/user-edit-modal.ejs) —
markup and script together, like `event-modal.ejs`. It binds to every `.edit-user` button on the page
(`data-email` / `data-name` / `data-position`), PUTs to `/api/users/:email`, and on success
dispatches a `user-updated` CustomEvent on `document` carrying the saved row. The partial deliberately
knows nothing about the including page's DOM: `members.ejs` listens for that event to patch its table row,
`profile.ejs` to patch the card, the avatar and the navbar name. Change the form once, in the partial —
including the `data-*` attributes, which every `.edit-user` button on every page has to supply.

Its footer also carries a "删除用户" button, rendered only when `user.role === 'ADMIN'` (rendering-only,
as everywhere — the route re-reads the role) and hidden by the open handler when the row being edited is
the viewer's own **or is itself an `ADMIN`** (`data-role` on the button); either case makes it invisible
on `/profile`. It arms on the first click and
sends the DELETE on the second, with the warning in the modal's own alert box rather than a native
`confirm()`, which stacks badly over a modal on a phone. Success dispatches `user-deleted` with
`detail.email` under the same contract as `user-updated`: `members.ejs` drops the row, renumbers the `#`
column (it is a position, not an id) and rewrites the header count.

The card is phone-first the way the member table is: below `sm` the 账号 and 姓名 rows
(`.profile-field-dup`) are hidden because the identity block at the top already shows both, the avatar
and the paddings shrink, and the label/value pairs stay side by side — stacking them is what makes a
card *taller*. On a phone the navbar collapses, which would bury the profile link behind the hamburger,
so [header.ejs](views/partials/header.ejs) renders it twice: `.navbar-profile` sits outside the collapse
below `lg`, the `.nav-user` item inside it takes over at `lg`. Both spans are `.nav-user-name`, so
anything renaming the user in place must write to **all** of them.

**The navbar is exactly one row tall on a phone**, and [main.css](public/css/main.css) keeps it that
way: `--gsf-navbar-h` (56px, 70px from `lg`) sets both the bar's `min-height` and the `padding-top`
the body reserves for it, so the two can't drift. Below `lg` the container is `flex-wrap: nowrap` —
Bootstrap otherwise wraps the hamburger onto a second line on a 320px screen, making the bar taller
than the reserved space and hiding the top of the page under it. The brand holds its width and the
member's name is the item that shrinks (`flex: 1 1 auto` + `min-width: 0`); at 320px even that isn't
enough, so `.brand-short`/`.brand-full` swap in a shorter club name below 360px. The open menu is
`position: absolute` under the bar rather than in flow, for the same reason: expanding it must not
change the navbar's height. Anything added to the bar has to fit that single row.

Because a member edits their own row through it, `PUT /api/users/:email` is gated by
`requireSelfOrAdminApi`, not `requireAdminApi`: the target email matching the session's is allowed
through, everything else is delegated to the admin guard (so the role is still re-read from the
database). This is only safe because `db.updateUser` can't write `role` — a self-service write that
could would be self-promotion. Gate any future user-write route the same way, or keep it admin-only.

**An `ADMIN` row's password, name and photo are writable only by that admin.** When the target email is
not the session's, `PUT /api/users/:email` re-reads the row and, if its role is `ADMIN`, accepts nothing
but `position` — a non-empty `password`, a `name` different from the stored one, or any
`profilePhoto` answers 403 (the form always resubmits the current name, so an unchanged one is not
treated as an edit). This is the same shape as the delete rule: an admin is edited or removed by
demoting them in SQL first. The modal mirrors it by `disabled`-ing 密码 and 姓名 and showing an info
box on those rows, and leaves the locked keys out of the PUT body entirely — rendering only, as
always. It hides the avatar's pencil on the same test. It reads the viewer's own address from
`data-self-email` on **the modal element**, not from the 删除用户 button, which only renders for admins.

## POC caveats deliberately left in

- `POST /members/add-users` and `POST /api/users` require `ADMIN`, and `PUT /api/users/:email`
  requires `ADMIN` for anyone but yourself, but an
  admin there can still reset any **non-admin** member's password — or delete that account outright
  through `DELETE /api/users/:email`, irreversibly and with no soft-delete — and nothing records who did it. A member
  changing their own password on `/profile` is likewise not asked for the current one. `GET /add-user`
  and `GET /member-list` are now just redirects to `/members` for old bookmarks, so they need no gate
  of their own.
- Creating an event is admin-only, and the "编辑" button only renders for admins, but the route behind it
  (`PUT /api/events/:id`) is still `requireLoginApi` — **any** logged-in member can edit any event they
  can *see* by calling it directly, as long as it has not ended yet — which includes raising `capacity`
  to promote themselves off the waitlist. They can no longer hide it from anybody: 可见范围 is gone, and
  `visibility` is not an editable field any more.
  `POST /event/:id/delete` *is* `requireAdmin`, but it deletes the event and its whole roster
  irreversibly, with no soft-delete and no record of who did it — the same shape as deleting a member.
  There is no JSON delete endpoint under `/api/events/:id`.
- **Being promoted off the waitlist is silent.** There is no mail, no push, nothing: the member finds
  out by opening the event page. Nothing displays `promoted_at` either, though it is recorded.
- **A 试训/Guest being added or 移出'd is silent too**, for the same reason and in the same way: the
  member the guest is coming through finds out by opening the event page. There is also **no way for a
  member to ask for one** — 添加 is admin-only, so arranging a 试训 happens off the app entirely, and an
  admin's 移出 **deletes** the row with no record that it was ever there and no undo but adding the
  guest again.
- A signup carries no cut-off. `POST /event/:id/signup` will still take a signup for an event whose date
  has passed — only the template hides the button — and 报名截止 times exist just in the description text.
- `SESSION_SECRET` falls back to a hardcoded string.
- Browser geolocation requires HTTPS or localhost; a phone needs ngrok/cloudflared, or use
  DevTools → Sensors to fake coordinates.
