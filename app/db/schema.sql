-- GSF demo: schema + seed data (PostgreSQL).
-- All objects live in the hardcoded `gsffc` schema.
-- Nothing in the app runs this file — apply it by hand before the first run.
-- This is the only DDL there is; there are no migration files. CREATE … IF NOT
-- EXISTS and ON CONFLICT DO NOTHING keep it safe to re-apply, so an existing
-- database is moved forward by running it again — anything that is not a fresh
-- create (a new column, a changed CHECK) is applied by hand in psql alongside it.

CREATE SCHEMA IF NOT EXISTS gsffc;

CREATE TABLE IF NOT EXISTS gsffc.users (
  email         TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  position      TEXT,
  joined        TEXT,
  role          TEXT NOT NULL DEFAULT 'MEMBER' CHECK (role IN ('MEMBER', 'ADMIN')),
  -- URL of the member's photo, e.g.
  -- https://raw.githubusercontent.com/gsffc/gsffc.github.io/refs/heads/main/assets/img/teams/GSF/donglin.jpg
  -- A photo uploaded from the edit-user modal lives in gsffc.user_photos and
  -- this column holds its own URL, '/photos/<email>?v=<upload time>'.
  -- NULL falls back to the gravatar built from the email.
  profile_photo TEXT
);

-- Avatars uploaded from the edit-user modal. The bytes are kept out of `users`
-- on purpose: every page that lists members SELECTs that table (the event page
-- reads all of them to build the roster), and a base64 picture per row would be
-- megabytes of query result nobody looks at. `users.profile_photo` keeps its
-- documented shape — a URL — and server.js serves this row from it.
--
-- `updated_at` is the cache key: the stored URL carries it as ?v=, so a new
-- upload is a new URL and no browser can go on showing the old picture.
-- Unlike the roster tables this one *does* carry a foreign key: a photo can
-- only ever belong to an account, so deleting the member takes it along.
CREATE TABLE IF NOT EXISTS gsffc.user_photos (
  email      TEXT PRIMARY KEY REFERENCES gsffc.users(email) ON DELETE CASCADE,
  mime       TEXT NOT NULL,
  bytes      BYTEA NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- `start_at` and `end_at` replace the old `date` + free-text `time` pair.
--
-- TIMESTAMP *without* time zone, deliberately: a club schedule is a wall clock
-- ("16:00 at the pitch"), not an instant, and it must not shift with whatever
-- timezone the server happens to run in (UTC on Netlify, local in dev).
-- TIMESTAMPTZ would convert on the way in and back out and move evening events
-- across midnight. db.js remaps this type to a plain 'YYYY-MM-DDTHH:MM' string
-- rather than a JS Date for the same reason — see the setTypeParser call there.
--
-- The app never stores seconds (the form is a minute-precision datetime-local),
-- and the CHECK below is what keeps it that way, so two events at the same
-- displayed time really are equal.
--
-- `date`, `endDate` and `time` still exist as read-only derived fields on the
-- app's event object (db.js `rowToEvent`), which is why the calendar kept working.
-- `visibility` is **no longer used by the app**: per-event visibility is gone,
-- and who may see an event is now 报名开放时间 alone (server.js `canSee` — an
-- event belongs to the administrators until 20:00 on the Wednesday before it,
-- and to every member after). Nothing reads or writes the column any more; it is
-- left in place, with its default and its CHECK, because this file is re-applied
-- to live databases and does not do destructive DDL. Drop it by hand in psql if
-- it is ever really wanted gone.
CREATE TABLE IF NOT EXISTS gsffc.events (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  start_at    TIMESTAMP NOT NULL,
  end_at      TIMESTAMP NOT NULL,
  location    TEXT,
  lat         DOUBLE PRECISION,
  lng         DOUBLE PRECISION,
  description TEXT,
  -- 总人数: the whole event's headcount — the members who sign up **and** the
  -- approved 试训/Guest, counted together. It is not a members-only 人数上限 any
  -- more: approving a guest takes one of these places, so the room left for
  -- members shrinks by itself, and everybody who arrives after the last place is
  -- gone — member or 试训 alike — is recorded on the waitlist.
  capacity    INTEGER NOT NULL DEFAULT 0,
  checkin_radius INTEGER NOT NULL DEFAULT 10,
  -- Unused; see the note above the table.
  visibility  TEXT NOT NULL DEFAULT 'ALL',
  -- 自动分队: how many teams this event is split into — 2, 3 or 4, picked by the
  -- admin on the event form. It used to be a hardcoded 3 in db.js, which meant a
  -- 板凳 on an event the club was playing 4-a-side. The team **size** is still
  -- derived on every read (已报名人数 + 试训人数 split team_count ways); only
  -- the count itself is stored, because it is a decision rather than a
  -- consequence. 3 is the default, i.e. what every pre-existing row reads as.
  -- db.js `TEAM_COUNTS`/`normalizeTeamCount` is what keeps the column to the
  -- three values; the CHECK below is the backstop.
  team_count  SMALLINT NOT NULL DEFAULT 3,
  CONSTRAINT events_end_after_start CHECK (end_at > start_at),
  CONSTRAINT events_visibility_shape CHECK (visibility IN ('ALL', 'ADMIN') OR visibility LIKE '%@%')
);

-- One row per member per event. `signed_up_at` is both the audit trail and the
-- ordering key: the roster is shown oldest-first, and the waitlist is served in
-- that same order when a place frees up.
--
-- `status` is the "type" of the signup. A member joining a full event is
-- recorded as WAITLIST and promoted to SIGNED_UP automatically — by a withdrawal
-- (db.js `withdrawFromEvent`), by an admin raising `capacity` (`updateEvent`) or
-- by a member being deleted (`deleteUser`). `promoted_at` records when that
-- happened and stays NULL for a signup that was confirmed from the start.
--
-- `email` deliberately carries no foreign key to `users`: the seeds below name
-- members that may not have accounts yet. db.js `deleteUser` cascades by hand.
CREATE TABLE IF NOT EXISTS gsffc.event_signups (
  event_id     TEXT NOT NULL REFERENCES gsffc.events(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'SIGNED_UP' CHECK (status IN ('SIGNED_UP', 'WAITLIST')),
  signed_up_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  promoted_at  TIMESTAMPTZ,
  PRIMARY KEY (event_id, email)
);

-- One row per check-in. `checked_in_at` is the arrival time; the coordinates and
-- the distance the server computed are kept as the evidence behind it.
-- A member may only check in while SIGNED_UP, and withdrawing deletes the row.
--
-- `checked_in_by` is 代签到: the admin who checked this member in on their
-- behalf, from POST /event/:id/checkin-for. NULL for the ordinary case — a
-- member checking themselves in — so a non-null value *is* the flag the event
-- page's 代 badge tests. When it is set, `lat`/`lng`/`distance_m` are the
-- **admin's** position, because the admin is the one who was at the pitch and
-- passed the geofence. No foreign key, for the same reason `email` has none.
--
-- `team_no` is 自动分队: the team this member was allocated to at the moment they
-- checked in, 1..`events.team_count`. The allocation is *random*, which is
-- exactly why it is the one part of the feature that has to be stored — the team
-- size (已报名人数 + 试训人数 split team_count ways, i.e. the confirmed rows in
-- `event_signups` plus the confirmed ones in `event_guests`) is derived
-- on every read and never written, so the teams re-size as members sign up or withdraw and
-- as guests are added, and no column can drift out of agreement with the
-- numbers it was computed from. Same arrangement as 迟到罚款. (The count itself is
-- stored, on the event, because it is the admin's decision — see there.)
--
-- It rides on the check-in rather than living in a table of its own because a
-- member is allocated *by arriving*: withdrawing, 清空报名, deleting the member
-- and deleting the event all drop the check-in row and take the allocation with
-- it, so there is no new cascade anywhere. NULL means "not allocated" — a
-- check-in recorded before this feature existed, or one on an event that had
-- nobody signed up and no guest at all.
CREATE TABLE IF NOT EXISTS gsffc.event_checkins (
  event_id      TEXT NOT NULL REFERENCES gsffc.events(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  checked_in_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lat           DOUBLE PRECISION,
  lng           DOUBLE PRECISION,
  distance_m    INTEGER,
  checked_in_by TEXT,
  team_no       SMALLINT,
  PRIMARY KEY (event_id, email)
);

-- Picking the next member off the waitlist, and counting the confirmed ones
-- against `capacity`, are the two hot queries; both are (event_id, status)
-- ordered by signup time.
CREATE INDEX IF NOT EXISTS event_signups_queue_idx
  ON gsffc.event_signups (event_id, status, signed_up_at);

-- 试训/Guest. A trialist or a guest has no account, so they can never sign up,
-- never check in and never appear on the roster — this table is the only record
-- of them, and it is what 自动分队 sizes the guest places from — every row is a
-- place, and the placement rule they are fed into is db.js `eventGuests`.
--
-- **Only an admin writes this table.** A row exists because an admin 添加'd it
-- and it is deleted outright when they 移出 it; there is no pending state and no
-- member-facing 申请 any more. **At most db.js MAX_EVENT_GUESTS (3) per event**,
-- counted under the event's row lock rather than being expressible as a
-- constraint here.
--
-- `approved_by`/`approved_at` are that admin and that moment — 添加人/添加时间,
-- kept under their old names because this file never rewrites a column
-- destructively. The CHECK keeps the pair honest: it is a who *and* a when. Rows
-- left pending by the old 申请/批准 flow have both NULL and count as ordinary
-- guests.
--
-- `type` is stored as the uppercase keyword, like `users.role` and
-- `event_signups.status`; 试训 / Guest are the labels server.js renders it as.
--
-- `requested_by` is the 申请人 the admin named — the member the guest is coming
-- through — and neither email carries a foreign key to `users`, for the same
-- reason `event_signups.email` doesn't, plus a second one: a guest is a body the
-- club is expecting, so deleting the member who invited them must not un-invite
-- them mid-event. db.js `deleteUser` therefore leaves these rows entirely alone,
-- with the dead address on them, exactly as `checked_in_by` keeps a deleted
-- admin's.
--
-- `status` is the same pair of keywords as `event_signups.status` and means the
-- same thing, because `events.capacity` is 总人数 — one number for every body
-- coming, a 试训 exactly like a member. A row therefore either holds one of those
-- places (SIGNED_UP) or queues for one (WAITLIST), and the two
-- tables share **one** waitlist, served strictly by when each row joined it:
-- `signed_up_at` for a signup, `approved_at` (添加时间) for a guest. `promoted_at` is when the
-- queue reached them, NULL for a guest confirmed from the start, the mirror of
-- `event_signups.promoted_at`. Rows written before the column existed read as
-- SIGNED_UP, which is what they were.
CREATE TABLE IF NOT EXISTS gsffc.event_guests (
  id           BIGSERIAL PRIMARY KEY,
  event_id     TEXT NOT NULL REFERENCES gsffc.events(id) ON DELETE CASCADE,
  type         TEXT NOT NULL CHECK (type IN ('TRIAL', 'GUEST')),
  name         TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by  TEXT,
  approved_at  TIMESTAMPTZ,
  status       TEXT NOT NULL DEFAULT 'SIGNED_UP',
  promoted_at  TIMESTAMPTZ,
  CONSTRAINT event_guests_approval_pair
    CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  -- Named, and named the same as the ALTER below adds: on a fresh database this
  -- one is created here and the ALTER then raises duplicate_object and is
  -- swallowed, so re-running the file never leaves two copies of the same rule.
  CONSTRAINT event_guests_status_shape CHECK (status IN ('SIGNED_UP', 'WAITLIST'))
);

-- The hot read is one event's rows in the order they were added, which is also
-- the order the guest places are handed out down the teams.
CREATE INDEX IF NOT EXISTS event_guests_event_idx
  ON gsffc.event_guests (event_id, approved_at, requested_at);

-- Counting the confirmed guests against 总人数, and picking the next queueing one
-- off the shared waitlist, are the two reads every roster write makes.
CREATE INDEX IF NOT EXISTS event_guests_queue_idx
  ON gsffc.event_guests (event_id, status, approved_at);
