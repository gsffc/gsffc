require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Resolve the views dir for both local runs and the bundled serverless function.
// `included_files` keeps each template's path relative to the *repository* root,
// not the Netlify base directory — so in the monorepo they land under `app/`
// inside the zip while __dirname is the bundled function's own directory
// (`/var/task/app/netlify/functions`). The second candidate is the one that
// resolves there; the last two cover a bundle built from a repo whose root is
// the app itself, as this used to be.
const viewsDir = [
  path.join(__dirname, 'views'),
  path.join(__dirname, '..', '..', 'views'),
  path.join(process.cwd(), 'views'),
  path.join(process.cwd(), 'app', 'views')
].find(p => fs.existsSync(p)) || path.join(__dirname, 'views');

app.set('view engine', 'ejs');
app.set('views', viewsDir);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Express 4 doesn't catch async errors; route rejections go to the error handler
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Page locals, set *before* the session store. The 500 handler at the bottom
// renders 404.ejs, and header.ejs reads `path` and `user` — so a failure inside
// the session store (an unreachable database, most often) used to throw
// "path is not defined" from the template and bury the real cause. These are the
// safe defaults; the middleware after session() fills in the signed-in user.
app.use((req, res, next) => {
  res.locals.user = null;
  res.locals.path = req.path;
  next();
});

// Deployment health check, mounted before the session middleware so it still
// answers when the session store is exactly what is broken. Reports whether the
// function can reach Postgres and see the gsffc schema, and never echoes the
// password back.
app.get('/healthz', wrap(async (req, res) => {
  const url = process.env.DATABASE_URL || process.env.SUPABASE_DATABASE_URL || '';
  const out = { ok: false, databaseUrlSet: Boolean(url), clubTimezone: CLUB_TIMEZONE };
  try {
    const parsed = new URL(url);
    out.host = parsed.hostname;
    out.port = parsed.port || '5432';
    out.database = parsed.pathname.replace(/^\//, '');
    out.username = parsed.username;
    out.sslmode = parsed.searchParams.get('sslmode') || null;
  } catch {
    out.urlParseError = 'DATABASE_URL is not a valid postgres:// URL';
  }
  try {
    const { rows } = await db.pool.query(
      "select current_database() as db, (select count(*) from information_schema.tables where table_schema = 'gsffc') as gsffc_tables"
    );
    out.ok = true;
    out.connectedTo = rows[0].db;
    out.gsffcTables = Number(rows[0].gsffc_tables);
  } catch (err) {
    out.error = { message: err.message, code: err.code, syscall: err.syscall, address: err.address };
  }
  res.status(out.ok ? 200 : 503).json(out);
}));

app.use(session({
  store: new PgSession({
    pool: db.pool,
    schemaName: 'gsffc',
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET || 'gsf-dev-secret',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 } // stay signed in for 30 days
}));

app.use(wrap(async (req, res, next) => {
  // Sessions created before roles existed carry no `role`. Backfill it once so
  // an admin who was already signed in still sees the admin nav without having
  // to log out; after that the copy is free for the life of the session.
  if (req.session.user && !req.session.user.role) {
    const fresh = await db.getUserByEmail(req.session.user.email);
    req.session.user.role = fresh ? fresh.role : db.MEMBER;
  }
  res.locals.user = req.session.user || null;
  res.locals.path = req.path;
  next();
}));

// Login-corner session probe (#10 contract): www.gsffc.org's shared header
// queries this to show the member's name. Same-site subdomains + default
// SameSite=Lax cookie means the session cookie is sent with
// credentials:"include"; CORS is scoped to www only (no wildcard — that
// combination is invalid with credentials).
app.get('/api/session', (req, res) => {
  res.set('Access-Control-Allow-Origin', 'https://www.gsffc.org');
  res.set('Access-Control-Allow-Credentials', 'true');
  res.vary('Origin');
  const user = req.session.user;
  if (!user) return res.status(401).json({ error: 'not signed in' });
  res.json({ name: user.name });
});

function requireLogin(req, res, next) {
  if (!req.session.user) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  next();
}

function requireLoginApi(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ ok: false, message: '请先登录' });
  }
  next();
}

// Admin gate. The session carries a copy of `role` for rendering, but it is only
// as fresh as the last login — and the cookie lives 30 days — so the role is
// re-read from the database here. That keeps a demotion effective immediately
// while leaving ordinary member traffic at its current query count.
function adminGuard({ api }) {
  return wrap(async (req, res, next) => {
    if (!req.session.user) {
      if (api) return res.status(401).json({ ok: false, message: '请先登录' });
      req.session.returnTo = req.originalUrl;
      return res.redirect('/login');
    }
    const fresh = await db.getUserByEmail(req.session.user.email);
    req.session.user.role = fresh ? fresh.role : db.MEMBER;
    if (!fresh || fresh.role !== db.ADMIN) {
      if (api) return res.status(403).json({ ok: false, message: '需要管理员权限' });
      return res.status(403).render('404', { title: 'Forbidden' });
    }
    next();
  });
}

const requireAdmin = adminGuard({ api: false });
const requireAdminApi = adminGuard({ api: true });

// Editing a member row: your own is self-service (the profile page), anyone
// else's is an admin power. The delegated branch still re-reads the role from
// the database, so this only widens who may write their *own* row — and
// `db.updateUser` cannot touch `role`, so it can't be used to self-promote.
function requireSelfOrAdminApi(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ ok: false, message: '请先登录' });
  }
  const target = String(req.params.email || '').trim().toLowerCase();
  if (target === req.session.user.email) return next();
  return requireAdminApi(req, res, next);
}

// The viewer, in the shape `canSee` wants — with the role re-read from the
// database rather than taken from the session's copy, which can be 30 days
// stale. Who may see an event is an access decision, so it gets the same
// treatment as `adminGuard`: one query, and the session copy refreshed along the
// way so a demoted admin stops seeing pre-open events at once.
// Pass `role` when the caller has already read the row (the event page reads
// every member to build its roster, so the viewer's fresh row is already in
// hand) and this costs nothing at all.
async function viewer(req, role) {
  const email = req.session.user.email;
  if (role === undefined) {
    const fresh = await db.getUserByEmail(email);
    role = fresh ? fresh.role : db.MEMBER;
  }
  req.session.user.role = role;
  return { email, role };
}

// 试训/Guest. db.js stores the two kinds as keywords, like every other enum in
// the schema; these are what they are called on the page, and the options the
// admin's 添加 form offers. A third kind means adding to `db.GUEST_TYPES` and here.
const GUEST_TYPE_LABELS = { [db.GUEST_TRIAL]: '试训', [db.GUEST_GUEST]: 'Guest' };
const guestTypeLabel = type => GUEST_TYPE_LABELS[type] || type;
const GUEST_TYPE_OPTIONS = db.GUEST_TYPES.map(t => ({ value: t, label: guestTypeLabel(t) }));

// One 试训/Guest as the page and the 添加/移出 dialog read it: the keyword turned
// into its label, both addresses turned into names, both timestamps formatted.
// `nameOf` is the caller's lookup over the member rows it has already read — an
// address with no account behind it (a deleted member) is handed back as-is,
// which is still truer than dropping who the guest is coming through.
// Every row is a place at the event: only an admin can add one, and 移出 deletes
// it outright, so there is no pending state left to distinguish.
function guestView(guest, nameOf) {
  return {
    id: guest.id,
    type: guest.type,
    typeLabel: guestTypeLabel(guest.type),
    // Which of the two kinds this is, as a flag rather than a keyword comparison
    // in two renderers: the chip is louder for a 试训 than for a Guest, and both
    // the page and the review dialog decide that from this one field.
    isTrial: guest.type === db.GUEST_TRIAL,
    name: guest.name,
    requestedBy: guest.requestedBy,
    requestedByName: nameOf(guest.requestedBy),
    requestedAt: formatStamp(guest.requestedAt),
    // 添加人/添加时间 — the admin who put the guest on the event.
    addedByName: guest.addedBy ? nameOf(guest.addedBy) : '',
    addedAt: formatStamp(guest.addedAt),
    // The row holds one of the event's 总人数 places — or queues for one beside
    // the members, which is what this says.
    waitlisted: guest.status === db.WAITLIST,
    promotedAt: formatStamp(guest.promotedAt)
  };
}

// The event's **one** waitlist, as a Map of key -> 1-based place: `m:<email>`
// for a member, `g:<id>` for a 试训/Guest. 总人数 counts the two kinds of body
// together, so a waitlisted member and a waitlisted guest are queueing for the
// same place and db.js promotes them strictly by when each joined the queue —
// `signed_up_at` for a signup, 添加时间 for a guest. They are *shown* in
// two different lists (the roster is an avatar grid and a guest has no account,
// so no picture), which is exactly why the numbering has to be worked out across
// both of them in one place: two lists each counting from 1 would have two
// different people believing they are next.
function queuePlaces(event) {
  return new Map([
    ...event.roster.filter(s => s.status === db.WAITLIST)
      .map(s => ({ key: `m:${s.email}`, at: s.signedUpAt })),
    ...event.guestWaitlist.map(g => ({ key: `g:${g.id}`, at: g.addedAt }))
  ].sort((a, b) => new Date(a.at) - new Date(b.at)).map((q, i) => [q.key, i + 1]));
}

// What the admin 添加/移出 dialog re-renders itself from after every action, so
// the list it shows comes from one fresh read rather than from patching a row
// into or out of it. The same `guestView` the page render uses, so a field added
// for one is in the other.
function guestPayload(event, users) {
  const byEmail = new Map(users.map(u => [u.email, u]));
  const nameOf = email => (byEmail.get(email) || {}).name || email;
  // `place` rides on every row for the same reason `waitlisted` does: the dialog
  // redraws itself from this payload after every action, so anything the first
  // paint shows has to be in here too or a 候补 number would vanish on an 添加.
  const places = queuePlaces(event);
  const guests = event.guestList.map(g => ({
    ...guestView(g, nameOf),
    place: places.get(`g:${g.id}`) || 0
  }));
  return {
    guests,
    max: db.MAX_EVENT_GUESTS,
    full: guests.length >= db.MAX_EVENT_GUESTS,
    // 总人数, so the dialog can say what an 添加 will actually do: with no places
    // left the next one lands the guest on the waitlist rather than at the event.
    // `max` above is the other cap and counts a different thing — how many
    // 试训/Guest the event may have at all, waitlisted ones included.
    capacity: event.capacity,
    placesTaken: event.placesTaken,
    placesLeft: event.placesLeft
  };
}

// Fallback avatar scheme, same as the production app (hackathon-starter gravatar
// helper). Used whenever a member has no `profile_photo` of their own; `size` is
// a gravatar parameter and has no equivalent for a stored photo, which is sized
// by the <img> box it lands in.
function gravatar(email, size = 80) {
  const hash = crypto.createHash('md5').update(email.trim().toLowerCase()).digest('hex');
  return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=retro`;
}

function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Event times are stored as a naive wall clock ('YYYY-MM-DDTHH:MM') because the
// club reads them as its own local time — but the process may well be running in
// UTC (it is, on Netlify), so a wall clock is not yet an instant. `CLUB_TIMEZONE`
// is the zone they are read in, and everything that compares an event against
// `Date.now()` — or renders a real timestamp — goes through the helpers below.
// Set it if the club is not in California.
const CLUB_TIMEZONE = process.env.CLUB_TIMEZONE || 'America/Los_Angeles';

// Offset in ms between the club's wall clock and UTC at a given instant — which
// is what makes this DST-aware rather than a fixed number.
function zoneOffset(epoch) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CLUB_TIMEZONE,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(epoch)).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day,
    +parts.hour % 24, +parts.minute, +parts.second);
  return asUTC - epoch;
}

// 'YYYY-MM-DDTHH:MM' read in the club's zone -> epoch ms, NaN if unparseable.
// The offset is looked up twice because it depends on the very instant being
// solved for: the first pass is a guess, the second lands it on the right side
// of a DST change.
function clubEpoch(wall) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(wall || ''));
  if (!m) return NaN;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return guess - zoneOffset(guess - zoneOffset(guess));
}

// "Today" in the club's zone, in the same YYYY-MM-DD shape as `event.date`, so
// every past/upcoming test stays a lexical comparison. It is emphatically *not*
// `new Date().toISOString()`: that is today in **UTC**, which after 17:00 in
// California is already tomorrow — an evening event was marked 已结束 while it
// was still hours away.
const clubDate = epoch => new Date(epoch + zoneOffset(epoch)).toISOString().slice(0, 10);
const todayStr = () => clubDate(Date.now());

// An event is over when it *ends*, not when its date rolls over: with the end
// time now stored, "已结束" and the closed check-in can both be exact. Falls
// back to the date if `endAt` is unparseable.
function hasEnded(event) {
  const end = clubEpoch(event.endAt);
  return Number.isFinite(end) ? end < Date.now() : event.date < todayStr();
}

// Check-in opens an hour before kick-off and closes when the event ends, the
// same instant that raises the 已结束 badge. The page counts down to this one,
// so the button and the route agree on when it opens.
const CHECKIN_LEAD_MS = 60 * 60 * 1000;
const checkinOpensAt = event => clubEpoch(event.startAt) - CHECKIN_LEAD_MS;

// 报名开放时间 — **20:00 club time on the Wednesday before the event**, and it is
// a club-wide rule rather than a per-event field: the club opens every week's
// signups at the same moment, so there is nothing for an admin to fill in and
// nothing that can be set wrong. Until it arrives the event **exists for
// administrators only** (see `canSee`), which is what gives them the window to
// arrange the week's 试训 before the club is let at the places.
//
// The instant is the last one of its kind strictly *before* kick-off, so it is
// always inside the week running up to the event: a Saturday match opens on the
// Wednesday three days earlier, and a Wednesday match at 19:00 — before 20:00 —
// opens a full week ahead rather than an hour after it has finished.
const SIGNUP_OPEN_DOW = 3;        // Wednesday, in Date's 0 = Sunday numbering
const SIGNUP_OPEN_TIME = '20:00'; // club wall clock, like every other event time

// The event's 报名开放时间 as an epoch, or NaN when `startAt` is unparseable —
// the same "fall back to open" every other gate takes on a malformed time.
// The date arithmetic is done in UTC on the **wall-clock date** (never on an
// instant), and only the finished wall clock goes through `clubEpoch`, so the
// answer is 20:00 in the club's zone on both sides of a DST change.
function signupOpensAt(event) {
  const startAt = String((event && event.startAt) || '');
  const date = startAt.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
  const day = new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)));
  // How many days back the last Wednesday is. On a Wednesday event that is
  // today — unless kick-off is at or before 20:00, in which case today's opening
  // would not be *before* the event and the week before is the right one.
  let back = (day.getUTCDay() - SIGNUP_OPEN_DOW + 7) % 7;
  if (back === 0 && startAt.slice(11, 16) <= SIGNUP_OPEN_TIME) back = 7;
  day.setUTCDate(day.getUTCDate() - back);
  return clubEpoch(`${day.toISOString().slice(0, 10)}T${SIGNUP_OPEN_TIME}`);
}

// Whether the club may see and sign up for this event yet. An unparseable time
// answers "open", like every other gate here.
function signupOpen(event) {
  const at = signupOpensAt(event);
  return !Number.isFinite(at) || Date.now() >= at;
}

// What the page and the calendar chip say about an event whose signups have not
// opened yet — null once they have.
function signupNote(event) {
  return signupOpen(event) ? null : `报名 ${formatStamp(signupOpensAt(event))} 开放`;
}

// **The** rule for who may see an event, and the one every route calls. It is
// time, and nothing else: before 报名开放时间 an event belongs to the
// administrators, so the club never sees a week's fixture until the same moment
// the places open. An admin sees everything, as always — otherwise they could
// not arrange the 试训 the window exists for.
//
// There is no per-event visibility any more: every event is open to every member
// once its signups do, which is what the Wednesday rule was for. A member who is
// refused is refused exactly as they are refused a missing event — the calendar
// and `/api/events` filter it out before anything is built from it, and every
// route handing one out 404s rather than 403ing, since a refusal would confirm
// the event exists.
function canSee(event, user) {
  if (!event || !user || !user.email) return false;
  if (user.role === db.ADMIN) return true;
  return signupOpen(event);
}

// The half of a check-in that is about *being there*: the window has to be open,
// and the posted position has to fall inside the event's radius. Both routes go
// through it — a member checking themselves in, and an admin checking somebody
// else in (代签到), where the position belongs to the admin, who is the one at
// the pitch. Keeping it in one place is what stops the proxy path from quietly
// becoming a looser one. Answers `{lat, lng, distance}` when the caller really
// is at the field, or `{status, body}` — the refusal to send back — when not.
function atTheField(event, body) {
  // Too early. The button is disabled until this instant as well, so hitting
  // this means either a hand-rolled request or a browser clock running fast.
  const opensAt = checkinOpensAt(event);
  if (Number.isFinite(opensAt) && Date.now() < opensAt) {
    return {
      status: 403,
      body: { ok: false, opensAt, message: '签到尚未开放：活动开始前 1 小时才能签到' }
    };
  }
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { status: 400, body: { ok: false, message: '未获取到有效位置' } };
  }
  const distance = Math.round(distanceMeters(lat, lng, event.coords.lat, event.coords.lng));
  if (distance > event.checkinRadius) {
    return {
      status: 403,
      body: {
        ok: false,
        distance,
        message: `签到失败：你距离球场约 ${distance} 米，需在 ${event.checkinRadius} 米范围内`
      }
    };
  }
  return { lat, lng, distance };
}

// 迟到罚款. Kick-off is a wall clock with no seconds, but a check-in is a real
// timestamp that has them — so "late" starts at kick-off + FINE_GRACE_MS, i.e.
// a check-in anywhere inside the starting minute is still on time (the club's
// rule: for a 19:50 kick-off, up to 19:50:58 is not late). Past that there is
// one boundary, FINE_TIER_MS after kick-off, and that instant itself is still
// the cheaper side of it. A member who never checked in owes the higher fine
// too, which is why absence and the far tier share FINE_VERY_LATE.
const FINE_GRACE_MS = 59 * 1000;
const FINE_TIER_MS = 5 * 60 * 1000;
const FINE_LATE = 5;
const FINE_VERY_LATE = 10;

// What one confirmed member owes for this event, and by how much they were
// late. `ended` is the caller's `hasEnded`: absence only costs once the event
// is over — before that a member who has not checked in has simply not arrived
// yet — so a live event fines nobody for not being there. An unparseable
// kick-off fines nobody at all, the same fallback every other gate takes.
// `lateMs` is null whenever there is no lateness to name.
function lateness(event, checkedInAt, ended) {
  if (!checkedInAt) return { fine: ended ? FINE_VERY_LATE : 0, lateMs: null };
  const late = new Date(checkedInAt).getTime() - clubEpoch(event.startAt);
  if (!Number.isFinite(late) || late < FINE_GRACE_MS) return { fine: 0, lateMs: null };
  return { fine: late <= FINE_TIER_MS ? FINE_LATE : FINE_VERY_LATE, lateMs: late };
}

// How late, for the roster tooltip. Seconds are shown under a minute only, so
// a 12-minute arrival reads "迟到 12 分钟" rather than "12 分 3 秒".
function lateLabel(ms) {
  const total = Math.floor(ms / 1000);
  const min = Math.floor(total / 60);
  return min ? `迟到 ${min} 分钟` : `迟到 ${total} 秒`;
}

// Signup and check-in times are real timestamps (unlike `event.date`), so they
// are formatted here rather than in the template: club-local time, minute
// precision, in the app's one display shape — `m/dd/yy HH:MM`, the same one the
// event page's 时间 row uses. The shift is what makes them club-local:
// `getHours()` would read them in the *process's* zone, which is UTC on Netlify,
// and a 22:23 check-in would be shown to the member as 05:23.
function formatStamp(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const local = new Date(d.getTime() + zoneOffset(d.getTime()));
  return `${local.getUTCMonth() + 1}/${pad2(local.getUTCDate())}/`
    + `${String(local.getUTCFullYear()).slice(2)} `
    + `${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}`;
}

// Fallback centre for the add-event picker map when no event has coords yet.
const DEFAULT_MAP_CENTER = { lat: 37.4045892, lng: -121.8907831 };

const pad2 = n => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad2(m + 1)}-${pad2(d)}`;

// Month grid for the calendar view. Weeks start on Sunday, and the grid is
// padded with the tail of the previous month and the head of the next one so
// every row holds 7 cells. Always 6 rows: the grid then keeps a constant height
// as the user pages between months instead of jumping around.
function buildMonthGrid(year, month, events, today) {
  const byDate = new Map();
  for (const e of events) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }
  // Local-time Date arithmetic only — never `new Date('YYYY-MM-DD')`, which
  // parses as UTC and can land on the wrong day west of Greenwich.
  const cursor = new Date(year, month, 1 - new Date(year, month, 1).getDay());
  const weeks = [];
  for (let w = 0; w < 6; w++) {
    const days = [];
    for (let d = 0; d < 7; d++) {
      const date = ymd(cursor.getFullYear(), cursor.getMonth(), cursor.getDate());
      days.push({
        date,
        day: cursor.getDate(),
        weekday: cursor.getDay(),
        inMonth: cursor.getMonth() === month,
        isToday: date === today,
        isPast: date < today,
        events: byDate.get(date) || []
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(days);
  }
  return weeks;
}

app.get('/', (req, res) => res.redirect('/calendar'));

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/calendar');
  res.render('login', { title: 'Login', error: null });
});

app.post('/login', wrap(async (req, res) => {
  const { email, password } = req.body;
  const user = await db.getUserByEmail((email || '').trim().toLowerCase());
  if (!user || !db.verifyPassword(user, password || '')) {
    return res.status(401).render('login', { title: 'Login', error: '账号或密码错误' });
  }
  req.session.user = { email: user.email, name: user.name, role: user.role };
  const dest = req.session.returnTo || '/calendar';
  delete req.session.returnTo;
  res.redirect(dest);
}));

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/calendar', requireLogin, wrap(async (req, res) => {
  const me = await viewer(req);
  // An event whose signups have not opened is not merely hidden from the grid —
  // it is dropped here, before anything is built out of it, so nothing
  // downstream (a count, a tooltip, the picker's map centre) can leak one.
  const events = (await db.getEvents()).filter(e => canSee(e, me));
  const today = todayStr();
  // What the chip's lock icon and tooltip say — the one thing that can still
  // narrow an event to administrators: 报名开放时间 not having arrived yet. Only
  // an admin can be looking at a pre-open event at all (the filter above is what
  // makes that true), so the lock only ever appears to somebody allowed to see
  // the event anyway. Set on the event objects themselves, because
  // `buildMonthGrid` hands the very same ones to the grid.
  for (const e of events) {
    e.signupNote = signupNote(e);
  }

  // ?month=YYYY-MM drives the grid; anything malformed falls back to this month.
  // "This month" comes out of the club-local date, not the process's own clock —
  // in UTC a December evening in California is already next year's January.
  const thisYear = Number(today.slice(0, 4));
  const thisMonth = Number(today.slice(5, 7)) - 1;
  let year = thisYear;
  let month = thisMonth;
  const requested = /^(\d{4})-(\d{2})$/.exec(req.query.month || '');
  if (requested) {
    const y = Number(requested[1]);
    const m = Number(requested[2]) - 1;
    if (y >= 1970 && y <= 9999 && m >= 0 && m <= 11) {
      year = y;
      month = m;
    }
  }
  const prev = new Date(year, month - 1, 1);
  const next = new Date(year, month + 1, 1);

  // Where the add-event modal's picker map opens: the latest event that has a
  // check-in point, so the club's usual fields are already on screen.
  const located = events.filter(e => e.coords);
  const mapCenter = located.length ? located[located.length - 1].coords : DEFAULT_MAP_CENTER;

  res.render('calendar', {
    title: '活动日历',
    weeks: buildMonthGrid(year, month, events, today),
    monthLabel: `${year}年${month + 1}月`,
    prevMonth: `${prev.getFullYear()}-${pad2(prev.getMonth() + 1)}`,
    nextMonth: `${next.getFullYear()}-${pad2(next.getMonth() + 1)}`,
    isCurrentMonth: year === thisYear && month === thisMonth,
    // The add-event modal reloads onto the new event's month with ?created=1,
    // which is what raises the success banner.
    created: req.query.created === '1',
    // Same idea for the other direction: POST /event/:id/delete sends the admin
    // back here, onto the month the deleted event was in, with ?deleted=1.
    deleted: req.query.deleted === '1',
    mapCenter,
    // What the modal's date field starts on: today when it is in view, so the
    // common case needs no picking, otherwise the 1st of the month being viewed.
    defaultDate: year === thisYear && month === thisMonth ? today : ymd(year, month, 1)
  });
}));

app.get('/event/:id', requireLogin, wrap(async (req, res) => {
  const event = await db.getEvent(req.params.id);
  if (!event) return res.status(404).render('404', { title: 'Not Found' });
  const users = await db.getUsers();
  const byEmail = new Map(users.map(u => [u.email, u]));
  // The viewer's own row is already in that map, so the freshly-read role
  // `canSee` needs costs no extra query here. An event the viewer may not see
  // answers exactly as a missing one does — a 403 would confirm it exists, which
  // is the one thing a hidden event must not do.
  const mineRow = byEmail.get(req.session.user.email);
  const me = await viewer(req, mineRow ? mineRow.role : db.MEMBER);
  if (!canSee(event, me)) return res.status(404).render('404', { title: 'Not Found' });
  // Needed before the roster is built, not just at render: whether the event is
  // over is what turns "has not checked in yet" into "did not turn up".
  const isPast = hasEnded(event);
  // `event.roster` is already ordered — confirmed members first, then the
  // waitlist, each half oldest signup first — so the index inside each half is
  // the member's place in it.
  const toParticipant = (signup, i) => {
    const u = byEmail.get(signup.email);
    // Only a confirmed place can be late to it: a waitlisted member was never
    // due at the event, so they are outside the fine rules entirely.
    const { fine, lateMs } = signup.status === db.SIGNED_UP
      ? lateness(event, signup.checkedInAt, isPast)
      : { fine: 0, lateMs: null };
    return {
      email: signup.email,
      name: u ? u.name : signup.email,
      position: u && u.position ? u.position : '',
      // Drawn at 48px in the roster grid, so the gravatar fallback is asked for
      // enough pixels to stay sharp on a phone's 2–3× screen.
      avatar: (u && u.profilePhoto) || gravatar(signup.email, 144),
      checkedIn: !!signup.checkedInAt,
      signedUpAt: formatStamp(signup.signedUpAt),
      checkedInAt: formatStamp(signup.checkedInAt),
      // 代签到: the admin who checked this member in for them, by name — null
      // for the ordinary self check-in, which is what the roster's 代 badge
      // tests. An admin who has since been deleted leaves their address behind,
      // which is still a truer answer than dropping the fact of the proxy.
      checkedInBy: signup.checkedInBy
        ? ((byEmail.get(signup.checkedInBy) || {}).name || signup.checkedInBy)
        : null,
      // 0 when nothing is owed; 5 or 10 otherwise. `lateLabel` is empty for a
      // member who never checked in — there is no arrival to be late by.
      fine,
      lateLabel: lateMs === null ? '' : lateLabel(lateMs),
      // 自动分队: 1..the event's 队伍数量, drawn at check-in. Null for anybody who has not arrived,
      // and for a check-in older than the feature — see db.js `pickTeam`.
      team: signup.team,
      place: i + 1
    };
  };
  const participants = event.roster.filter(s => s.status === db.SIGNED_UP).map(toParticipant);
  // 候补名单 is **one queue** — see `queuePlaces`. The member's place in it is
  // therefore not this list's own index: a 试训 queueing ahead of them counts.
  const queuePlace = queuePlaces(event);
  const waitlist = event.roster.filter(s => s.status === db.WAITLIST)
    .map((s, i) => ({ ...toParticipant(s, i), place: queuePlace.get(`m:${s.email}`) || i + 1 }));
  const mine = event.roster.find(s => s.email === req.session.user.email) || null;
  // 自动分队 — visible only to somebody who has actually turned up. The teams are
  // read at the pitch, by the people about to play, so checking in is the price
  // of seeing them, and it is the **one** thing on this page an admin does not
  // see by right: an admin who is playing checks in like everybody else (or is
  // checked in by 代签到), and one who is not has no team to read. Deliberately
  // no `me.role === db.ADMIN` branch here.
  const seesTeams = !!mine && !!mine.checkedInAt;
  const allocated = participants.filter(p => p.team);
  // The playing teams always render, an empty one saying so rather than
  // vanishing — a team nobody has been drawn into yet is information, and the
  // block would otherwise change shape as members arrive. The **板凳** is the
  // exception: it is the overflow, so an empty one means simply that nobody has
  // overflowed, and a row saying 无 would be noise on every ordinary event. That
  // is a 3-team thing only — in the 2- and 4-team layouts the last team is a
  // playing team that happens to also be the overflow, and it renders like the
  // rest.
  // Null when there is nothing to show at all (nobody allocated yet, an event
  // with no team size, or check-ins predating 自动分队), so the template has one
  // test rather than a length check per team.
  // Each name carries `isMe` so the viewer's own is marked in the list — the one
  // thing they are looking for is which team they are in. Matched on **email**,
  // never on the name, since two members can share one.
  //
  // The 试训/guest places (`event.guests`, the event's **confirmed** guests placed
  // by db.js `eventGuests`) come **after** every member of the team: they are the
  // bodies who signed up through somebody else, so they sort last rather than
  // into the middle of a list somebody is scanning for their own name. The type
  // rides in the name here because it is UI text — db.js stores the keyword.
  // 板凳 exists only in the 3-team layout, and it is the only row that can be
  // dropped for being empty.
  const benchNo = event.teamCount === 3 ? 3 : 0;
  const teams = allocated.length && seesTeams
    ? Array.from({ length: event.teamCount }, (_, i) => ({
      no: i + 1,
      members: [
        ...allocated.filter(p => p.team === i + 1).map(p => ({
          name: p.name,
          isMe: p.email === req.session.user.email
        })),
        ...event.guests.filter(g => g.team === i + 1).map(g => ({
          name: `${g.name}（${guestTypeLabel(g.type)}）`,
          isMe: false,
          isGuest: true
        }))
      ]
    })).filter(t => t.no !== benchNo || t.members.length)
    : null;
  // 试训/Guest. **The list is public** — who else is coming is the same class of
  // fact as the roster. Only an admin can add or remove one, so nothing here is
  // per-viewer any more.
  const nameOf = email => (byEmail.get(email) || {}).name || email;
  const guestList = event.guestList.map(g => ({
    ...guestView(g, nameOf),
    // Their place in the one queue above, for a waitlisted one; 0 otherwise.
    place: queuePlace.get(`g:${g.id}`) || 0
  }));
  // `guestList` is what the MAX_EVENT_GUESTS count is against — that cap is on
  // having a 试训/Guest at all, not on holding a place. The two lists under it are
  // what the sidebar renders: the guests holding one of the event's 总人数
  // places, and the ones queueing for one.
  const confirmedGuests = guestList.filter(g => !g.waitlisted);
  const waitlistedGuests = guestList.filter(g => g.waitlisted);
  res.render('event', {
    title: event.title,
    event,
    // Centre for the admin edit modal's picker: this event's own check-in point
    // when it has one, so opening the modal shows the field already in place.
    mapCenter: event.coords || DEFAULT_MAP_CENTER,
    participants,
    waitlist,
    signedUp: !!mine && mine.status === db.SIGNED_UP,
    waitlisted: !!mine && mine.status === db.WAITLIST,
    // 1-based place in the queue, so a waitlisted member is told how many are
    // ahead of them rather than just that they are waiting.
    myPlace: mine && mine.status === db.WAITLIST
      ? (queuePlace.get(`m:${mine.email}`) || 0)
      : 0,
    checkedIn: !!mine && !!mine.checkedInAt,
    myCheckinAt: formatStamp(mine && mine.checkedInAt),
    teams,
    // There *are* teams, but this viewer hasn't earned sight of them yet — the
    // page says why instead of silently showing nothing.
    teamsLocked: !!allocated.length && !seesTeams,
    // Set by the redirect from POST /event/:id/signup when the event was full.
    joinedWaitlist: req.query.joined === 'waitlist',
    // 试训/Guest — public, and admin-managed: the page only reads it.
    guestList,
    confirmedGuests,
    waitlistedGuests,
    maxGuests: db.MAX_EVENT_GUESTS,
    // 总人数: `capacity` is the whole event's headcount — members **and** 试训 —
    // so these are what the roster head and the signup button read. Approving a
    // 试训 really does take a place off the members, which is the point.
    placesTaken: event.placesTaken,
    placesLeft: event.placesLeft,
    full: event.placesLeft <= 0,
    // 报名开放时间 — 20:00 on the Wednesday before. Before it, only an admin is
    // looking at this page at all, and nobody may sign up yet; the note is what
    // says so instead of the button.
    signupOpen: signupOpen(event),
    signupOpensAt: signupOpensAt(event),
    signupNote: signupNote(event),
    guestTypes: GUEST_TYPE_OPTIONS,
    isPast,
    // The 罚款 panel, which exists only on a finished event: the fines are not
    // final until nobody can still arrive. Null before that, so the template
    // has one test rather than a length check per tier. Both tiers are always
    // present, empty list and all, so the panel says who owes $5 *and* who owes
    // $10 even when one of them is nobody.
    fines: isPast
      ? [FINE_LATE, FINE_VERY_LATE].map(amount => ({
        amount,
        names: participants.filter(p => p.fine === amount).map(p => p.name)
      }))
      : null,
    // The event's three instants, plus the clock the server measured them
    // against: the page counts down against `Date.now()` corrected by the
    // difference, so a phone whose clock is off doesn't offer a button the route
    // will refuse (or hide one it would accept). All three are on the page so an
    // event that opens, starts or ends while it sits open moves the status badge
    // and the button itself, rather than leaving a stale page behind. Kick-off
    // is the one the route does *not* gate on — check-in stays open past it —
    // but it is when the button turns urgent and the fines start.
    checkinOpensAt: checkinOpensAt(event),
    eventStartsAt: clubEpoch(event.startAt),
    checkinClosesAt: clubEpoch(event.endAt),
    serverNow: Date.now(),
    // Options for the 申请人 picker in the admin's 添加试训/Guest dialog.
    members: me.role === db.ADMIN ? users.map(u => ({ email: u.email, name: u.name })) : []
  });
}));

// Signing up for a full event is not refused: `db.signUpForEvent` records it as
// a WAITLIST signup instead, and the redirect carries ?joined=waitlist so the
// page can say so. The capacity decision is made under a row lock in there, not
// here, so two members racing for the last place can't both take it.
app.post('/event/:id/signup', requireLogin, wrap(async (req, res) => {
  // An event you may not see is one you may not join, and it answers as a
  // missing one rather than as a refusal. Withdrawing deliberately carries no
  // such check — a member whose event was restricted after they signed up must
  // still be able to take their place back out of it.
  const event = await db.getEvent(req.params.id);
  if (!event || !canSee(event, await viewer(req))) {
    return res.status(404).render('404', { title: 'Not Found' });
  }
  // 报名 opens for **everybody** at 20:00 on the Wednesday before, administrators
  // included: the window before it is for arranging 试训, not for taking places
  // ahead of the club. A member cannot even see the event by then, so this
  // catches an admin's own button and a hand-crafted POST, and lands back on the
  // event unchanged — the same shape as the frozen 清空报名.
  if (!signupOpen(event)) return res.redirect(`/event/${req.params.id}`);
  const result = await db.signUpForEvent(req.params.id, req.session.user.email);
  if (!result) return res.status(404).render('404', { title: 'Not Found' });
  const waitlisted = result.created && result.status === db.WAITLIST;
  res.redirect(`/event/${req.params.id}${waitlisted ? '?joined=waitlist' : ''}`);
}));

// Leaving hands the place the member held to the head of the waitlist, inside
// `db.withdrawFromEvent`'s transaction. A member who has already checked in is
// refused there — arriving is final, see the note on that function — and the
// page has no 取消报名 button for them by then, so this lands back on the event
// unchanged, the same shape as the frozen 清空报名 above.
app.post('/event/:id/withdraw', requireLogin, wrap(async (req, res) => {
  const result = await db.withdrawFromEvent(req.params.id, req.session.user.email);
  if (!result) return res.status(404).render('404', { title: 'Not Found' });
  res.redirect(`/event/${req.params.id}`);
}));

// The two admin 试训/Guest actions behind the 添加/移出 试训/Guest dialog — the
// only way a guest gets onto an event or off it. They answer JSON and each one
// hands back the event's **whole** refreshed guest payload, so the dialog
// re-renders its list from one fresh read instead of moving a row by hand: an
// 添加 or a 移出 changes the list, how many of the three places are used and how
// many of the event's 总人数 places are left, all at once. Admin-only and frozen
// on a finished event, like every other write to it.
// `action` returns { ok, reason } from db.js, or null for "no such event".
function guestAction(action) {
  return wrap(async (req, res) => {
    // No `canSee`, like every other admin-only route: an admin sees every
    // event, so the rule could only ever pass.
    const event = await db.getEvent(req.params.id);
    if (!event) return res.status(404).json({ ok: false, message: '活动不存在' });
    if (hasEnded(event)) {
      return res.status(400).json({ ok: false, message: '活动已结束，无法修改试训/Guest' });
    }
    let result;
    try {
      result = await action(req);
    } catch (err) {
      return res.status(400).json({ ok: false, message: err.message });
    }
    if (!result) return res.status(404).json({ ok: false, message: '活动不存在' });
    if (!result.ok) {
      const message = result.reason === 'full'
        ? `试训/Guest 名额已满（最多 ${db.MAX_EVENT_GUESTS} 位），请先移出一位`
        : '该试训/Guest 不存在';
      return res.status(400).json({ ok: false, message });
    }
    // Re-read rather than patching the event object in hand: the payload is what
    // the dialog redraws from, and it must be the state the next admin would see.
    const [fresh, users] = await Promise.all([db.getEvent(req.params.id), db.getUsers()]);
    if (!fresh) return res.status(404).json({ ok: false, message: '活动不存在' });
    res.json({ ok: true, guests: guestPayload(fresh, users) });
  });
}

const guestIdOf = req => {
  const id = Number(req.params.guestId);
  if (!Number.isInteger(id)) throw new Error('该试训/Guest 不存在');
  return id;
};

// 直接添加试训/Guest — the admin's only entry point, and the guest's: a member
// cannot ask for one. The row is a place the moment it is written.
// `requestedBy` is the 申请人 the dialog asks for — the member the guest is coming
// through, defaulting to the admin doing the adding. The address is checked
// because it carries no foreign key: a typo would otherwise record a guest as
// submitted by nobody, and the sidebar would render the raw address where a
// member's name belongs.
app.post('/api/events/:id/guests', requireAdminApi, guestAction(async (req) => {
  const requestedBy = String(req.body.requestedBy || '').trim().toLowerCase();
  if (requestedBy && !(await db.getUserByEmail(requestedBy))) {
    throw new Error(`找不到成员 ${requestedBy}`);
  }
  return db.addEventGuest(req.params.id, {
    type: req.body.type,
    name: req.body.name,
    by: req.session.user.email,
    requestedBy
  });
}));

// 移出 — the row is **deleted**. A guest is on the event because an admin put
// them there, so taking them off is removing the record of it, not sending it
// back to anywhere; db.js frees the 总人数 place with it and promotes the head of
// the queue.
app.post('/api/events/:id/guests/:guestId/remove', requireAdminApi, guestAction(req =>
  db.removeEventGuest(req.params.id, guestIdOf(req))));

// Wipe an event's roster. Destructive and admin-only — the waitlist and the
// check-ins go with the signups, since a check-in from someone no longer on the
// list is meaningless and a waitlist with nobody ahead of it is noise.
// A finished event's roster is the record of who actually turned up, so it is
// frozen the minute the event ends — the same instant that raises 已结束 and
// closes the check-in. The button is gone from the page by then; this catches a
// hand-crafted POST, and lands back on the event so the admin sees it unchanged.
app.post('/event/:id/clear-signups', requireAdmin, wrap(async (req, res) => {
  const event = await db.getEvent(req.params.id);
  if (!event) return res.status(404).render('404', { title: 'Not Found' });
  if (hasEnded(event)) return res.redirect(`/event/${req.params.id}`);
  const result = await db.clearEventRoster(req.params.id);
  if (!result) return res.status(404).render('404', { title: 'Not Found' });
  res.redirect(`/event/${req.params.id}`);
}));

// Delete an event outright. Admin-only and irreversible — the roster goes with
// it through the tables' ON DELETE CASCADE. The event page it was invoked from
// is gone, so it lands on the calendar showing the month the event was in, with
// ?deleted=1 raising the banner there.
// Frozen once the event has ended, like clearing its roster: a past event is the
// club's record of it, and deleting takes the signups and check-ins with it.
app.post('/event/:id/delete', requireAdmin, wrap(async (req, res) => {
  const event = await db.getEvent(req.params.id);
  if (!event) return res.status(404).render('404', { title: 'Not Found' });
  if (hasEnded(event)) return res.redirect(`/event/${req.params.id}`);
  const deleted = await db.deleteEvent(req.params.id);
  if (!deleted) return res.status(404).render('404', { title: 'Not Found' });
  res.redirect(`/calendar?month=${deleted.date.slice(0, 7)}&deleted=1`);
}));

// Copying an event no longer has a route of its own: the 复制 button opens the
// event modal prefilled and a week on, so the copy goes through POST /api/events
// like any other creation — with the admin able to adjust it before it is saved.

app.post('/event/:id/checkin', requireLogin, wrap(async (req, res) => {
  const event = await db.getEvent(req.params.id);
  if (!event) return res.status(404).json({ ok: false, message: '活动不存在' });
  // Same answer as a missing event, for the same reason as the signup route.
  if (!canSee(event, await viewer(req))) {
    return res.status(404).json({ ok: false, message: '活动不存在' });
  }
  if (!event.coords) return res.status(400).json({ ok: false, message: '该活动为线上活动，无需到场签到' });
  if (hasEnded(event)) {
    return res.status(400).json({ ok: false, message: '活动已结束，无法签到' });
  }
  const email = req.session.user.email;
  const mine = event.roster.find(s => s.email === email);
  if (!mine) {
    return res.status(400).json({ ok: false, message: '请先报名再签到' });
  }
  // A waitlisted member has no place at the event yet, so there is nothing to
  // check in to; they become eligible the moment they are promoted.
  if (mine.status === db.WAITLIST) {
    return res.status(400).json({ ok: false, message: '你在候补名单中，补位成功后才能签到' });
  }
  if (mine.checkedInAt) {
    // The allocation is never reached from here — the row already exists, and an
    // existing row is never re-teamed. A check-in from before 自动分队 stays NULL.
    return res.json({ ok: true, message: '你已签到过了' });
  }
  const where = atTheField(event, req.body);
  if (where.status) return res.status(where.status).json(where.body);
  // The coordinates go in with the time, as the evidence behind the row, and the
  // 自动分队 draw happens in there too — `team` is null only when the event has no
  // team size at all (nobody signed up and no guest), the "no teams
  // here" answer.
  const done = await db.checkInToEvent(event.id, email, where);
  // The event was deleted between the read above and the write; nothing was
  // recorded, so this must not answer 签到成功.
  if (!done) return res.status(404).json({ ok: false, message: '活动不存在' });
  res.json({
    ok: true,
    distance: where.distance,
    team: done.team,
    message: `签到成功！(距球场约 ${where.distance} 米)`
  });
}));

// 代签到 — an admin standing at the pitch checking in a member who can't do it
// themselves (a dead phone, no signal, no app). It is deliberately *not* a way
// around the geofence: every gate the member's own check-in passes is applied
// here too, and the position measured and stored is the **admin's**, because the
// admin is the one who is actually there. What makes the row different is
// `checked_in_by`: the roster renders it as a 代 badge naming who did it, so a
// proxy check-in is never mistaken for the member having turned up with a phone.
// Fines are untouched by this — `lateness` reads `checked_in_at` alone, so a
// member checked in late by an admin owes exactly what they would have owed.
app.post('/event/:id/checkin-for', requireAdminApi, wrap(async (req, res) => {
  // No `canSee` here, like every other admin-only route: an admin sees
  // every event, so the rule could only ever pass.
  const event = await db.getEvent(req.params.id);
  if (!event) return res.status(404).json({ ok: false, message: '活动不存在' });
  if (!event.coords) return res.status(400).json({ ok: false, message: '该活动为线上活动，无需到场签到' });
  if (hasEnded(event)) return res.status(400).json({ ok: false, message: '活动已结束，无法签到' });
  const target = String(req.body.email || '').trim().toLowerCase();
  const theirs = event.roster.find(s => s.email === target);
  if (!theirs) return res.status(400).json({ ok: false, message: '该成员未报名本次活动' });
  if (theirs.status === db.WAITLIST) {
    return res.status(400).json({ ok: false, message: '该成员在候补名单中，补位成功后才能签到' });
  }
  if (theirs.checkedInAt) return res.json({ ok: true, email: target, message: '该成员已签到过了' });
  const where = atTheField(event, req.body);
  if (where.status) return res.status(where.status).json(where.body);
  const done = await db.checkInToEvent(event.id, target, { ...where, by: req.session.user.email });
  if (!done) return res.status(404).json({ ok: false, message: '活动不存在' });
  res.json({
    ok: true,
    email: target,
    distance: where.distance,
    // The member's 自动分队 draw, so the dialog can name it as the admin works
    // through the list; null when the event has no team size at all.
    team: done.team,
    message: `代签到成功！(距球场约 ${where.distance} 米)`
  });
}));

// The member list doubles as the admin bulk-add page, so both the plain GET and
// the post-submit render go through here.
async function renderMembers(res) {
  const members = await db.getUsers();
  res.render('members', {
    title: '会员列表',
    // The edit modal opens on the member's avatar, so every row carries the
    // gravatar to fall back to. It can only be built here — it is an md5 of the
    // address — and it is asked for 192px because the modal draws it at 96.
    members: members.map(m => ({ ...m, avatarFallback: gravatar(m.email, 192) }))
  });
}

// The signed-in member's own record, reached from their name in the navbar.
// Read fresh from the database rather than from the session copy, which holds
// only email/name/role and can be up to 30 days stale.
app.get('/profile', requireLogin, wrap(async (req, res) => {
  const row = await db.getUserByEmail(req.session.user.email);
  // The account was deleted (or renamed) out from under a live session.
  if (!row) return req.session.destroy(() => res.redirect('/login'));
  req.session.user.name = row.name;
  req.session.user.role = row.role;
  res.render('profile', {
    title: '个人资料',
    profile: {
      email: row.email,
      name: row.name,
      position: row.position,
      joined: row.joined,
      role: row.role,
      // getUserByEmail hands back the raw row (it carries password_hash too),
      // so this is the one place the column keeps its snake_case name.
      profilePhoto: row.profile_photo || ''
    },
    // The member's own photo when they have set one, gravatar otherwise. The
    // fallback goes along too: the page swaps back to it without a reload when
    // the photo is cleared in the modal, or when the URL fails to load. 192px
    // covers both boxes it lands in — 72 on the card, 96 in the edit modal.
    avatar: row.profile_photo || gravatar(row.email, 192),
    avatarFallback: gravatar(row.email, 192)
  });
}));

app.get('/members', requireLogin, wrap(async (req, res) => {
  await renderMembers(res);
}));

// Bulk add / reset members by pasting "username:password" lines. Split on the
// first colon only, so passwords may themselves contain ':'.
function parseUserLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const i = line.indexOf(':');
      if (i === -1) return { line, error: '缺少冒号，格式应为 username:password' };
      const email = line.slice(0, i).trim();
      const password = line.slice(i + 1);
      if (!email) return { line, error: '账号为空' };
      if (!password) return { line, error: '密码为空' };
      return { line, email, password };
    });
}

// Old URLs that are gone; keep them working for bookmarks.
app.get('/add-user', (req, res) => res.redirect('/members'));
app.get('/member-list', (req, res) => res.redirect('/members'));

// Answers JSON to the modal's fetch rather than re-rendering /members: rendering
// the result of the POST left the browser sitting on /members/add-users, so a
// refresh re-submitted the whole paste. Same reason it carries the API guard.
app.post('/members/add-users', requireAdminApi, wrap(async (req, res) => {
  const parsed = parseUserLines(req.body.users);
  const results = [];
  for (const item of parsed) {
    if (item.error) {
      results.push({ line: item.line, ok: false, message: item.error });
      continue;
    }
    try {
      const user = await db.upsertUser({ email: item.email, password: item.password });
      results.push({
        line: item.line,
        ok: true,
        email: user.email,
        message: user.inserted ? '已创建' : '已更新密码'
      });
    } catch (err) {
      console.error(err);
      results.push({ line: item.line, ok: false, message: err.message });
    }
  }
  res.json({ ok: results.length > 0 && results.every(r => r.ok), results });
}));

// Same capability as the bulk-add form, so it carries the same gate — leaving it
// open would make the page-level check cosmetic.
app.post('/api/users', requireAdminApi, wrap(async (req, res) => {
  const username = (req.body.username || '').trim().toLowerCase();
  const password = req.body.password || '';
  if (!username || !password) {
    return res.status(400).json({ ok: false, message: 'username 和 password 为必填项' });
  }
  try {
    const user = await db.createUser(username, password);
    res.status(201).json(user);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ ok: false, message: '用户已存在' });
    }
    throw err;
  }
}));

// Backs the per-member edit modal on /members and the same form on
// /profile. Only the keys present in the body are written, so an empty password
// box keeps the current password.
app.put('/api/users/:email', requireSelfOrAdminApi, wrap(async (req, res) => {
  const email = String(req.params.email || '').trim().toLowerCase();
  const patch = { email };
  if (req.body.password) patch.password = req.body.password;
  if (req.body.name !== undefined) patch.name = req.body.name;
  if (req.body.position !== undefined) patch.position = req.body.position;
  if (req.body.profilePhoto !== undefined) patch.profilePhoto = req.body.profilePhoto;

  // An admin's credentials and identity are theirs alone: nobody else — not even
  // another admin — may change an ADMIN row's password or name, only 场上位置.
  // The role is re-read from the database, like every other admin check; the
  // modal's data-role and the session copy are rendering only. The form always
  // resubmits the current name, so only an actual change is refused.
  if (email !== req.session.user.email) {
    const target = await db.getUserByEmail(email);
    if (!target) return res.status(404).json({ ok: false, message: '用户不存在' });
    if (target.role === db.ADMIN) {
      const renaming = patch.name !== undefined
        && String(patch.name).trim() !== String(target.name || '').trim();
      if (patch.password || renaming || patch.profilePhoto !== undefined) {
        return res.status(403).json({
          ok: false,
          message: '管理员的密码和姓名只能由本人修改，其他人只能修改场上位置'
        });
      }
      delete patch.password;
      delete patch.name;
      delete patch.profilePhoto;
    }
  }

  let user;
  try {
    user = await db.updateUser(patch);
  } catch (err) {
    return res.status(400).json({ ok: false, message: err.message });
  }
  if (!user) return res.status(404).json({ ok: false, message: '用户不存在' });
  // An admin renaming themselves would otherwise keep the old name in the navbar
  // until the next login, since the session only holds a copy.
  if (req.session.user.email === user.email) req.session.user.name = user.name;
  res.json({ ok: true, user });
}));

// An uploaded avatar is bytes in `gsffc.user_photos`; `users.profile_photo`
// keeps its documented shape and holds the URL below. The upload is limited to
// what a picture can be, and the *magic bytes* decide the type rather than the
// Content-Type header — the value is handed straight back to a browser as an
// image, so nothing may be stored that isn't one. The modal downscales to a
// 512px square JPEG before sending, so the limit here is headroom, not a target.
const PHOTO_MAX_BYTES = 3 * 1024 * 1024;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('hex', 0, 8) === '89504e470d0a1a0a') return 'image/png';
  if (buf.toString('latin1', 0, 3) === 'GIF') return 'image/gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

// Serve a stored avatar. Gated like every other member-facing route, but with a
// bare 401 rather than `requireLogin`: this is an <img> src, and a redirect to
// /login would both render as a broken image and leave the picture's URL in
// `returnTo` as where to go after signing in. The stored URL carries the upload
// time as ?v=, so each upload is a distinct URL and this response can be cached
// for good — a replaced picture is simply never requested again.
app.get('/photos/:email', wrap(async (req, res) => {
  if (!req.session.user) return res.sendStatus(401);
  const photo = await db.getUserPhoto(req.params.email);
  if (!photo) return res.sendStatus(404);
  res.set('Content-Type', photo.mime);
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.send(photo.bytes);
}));

// Backs the pencil on the avatar in the edit-user modal: the picked file is
// resized in the browser and POSTed here as raw image bytes (no multipart, no
// upload library). Same gate as the PUT above — your own row is self-service,
// anyone else's is an admin power — and the same rule for an admin's row.
app.post('/api/users/:email/photo',
  requireSelfOrAdminApi,
  express.raw({ type: PHOTO_TYPES, limit: PHOTO_MAX_BYTES }),
  wrap(async (req, res) => {
    const email = String(req.params.email || '').trim().toLowerCase();
    // An admin's identity is theirs alone, exactly as for the password and the
    // name: the role is re-read here, never taken from the session copy.
    if (email !== req.session.user.email) {
      const target = await db.getUserByEmail(email);
      if (!target) return res.status(404).json({ ok: false, message: '用户不存在' });
      if (target.role === db.ADMIN) {
        return res.status(403).json({ ok: false, message: '管理员的头像只能由本人修改' });
      }
    }
    // express.raw leaves an empty object when the Content-Type didn't match.
    const mime = sniffImage(req.body);
    if (!mime) return res.status(415).json({ ok: false, message: '只能上传图片文件' });
    const user = await db.setUserPhoto(email, { mime, bytes: req.body });
    if (!user) return res.status(404).json({ ok: false, message: '用户不存在' });
    res.json({ ok: true, user });
  }));

// Backs the "删除用户" button in the edit modal. Admin-only — unlike the PUT
// above there is no self-service branch: deleting your own account would destroy
// the session doing the deleting, and the last admin could lock everyone out of
// member management (there is no UI for promoting a replacement).
app.delete('/api/users/:email', requireAdminApi, wrap(async (req, res) => {
  const email = String(req.params.email || '').trim().toLowerCase();
  if (email === req.session.user.email) {
    return res.status(400).json({ ok: false, message: '不能删除自己的账号' });
  }
  // No admin may be deleted, by anyone. The modal hides the button for admin
  // rows, but that is rendering only — the role is re-read here so a direct
  // call can't get past it. Demote to MEMBER in SQL first if it really has to go.
  const target = await db.getUserByEmail(email);
  if (!target) return res.status(404).json({ ok: false, message: '用户不存在' });
  if (target.role === 'ADMIN') {
    return res.status(403).json({ ok: false, message: '不能删除管理员账号' });
  }
  const user = await db.deleteUser(email);
  if (!user) return res.status(404).json({ ok: false, message: '用户不存在' });
  res.json({ ok: true, user });
}));

// A stored start/end: local wall clock to the minute, in the exact shape an
// <input type="datetime-local"> carries. The fixed width is what lets the rest
// of the app compare these lexically, so nothing looser may be written.
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function isRealDateTime(value) {
  const m = typeof value === 'string' && DATETIME_RE.exec(value);
  if (!m) return false;
  const [y, mo, d, hh, mi] = m.slice(1).map(Number);
  if (hh > 23 || mi > 59) return false;
  // The regex accepts things like 2026-02-31; round-tripping through Date does
  // not. Local-time constructor, as everywhere else here.
  const probe = new Date(y, mo - 1, d);
  return probe.getFullYear() === y && probe.getMonth() === mo - 1 && probe.getDate() === d;
}

// Shared by create and update: coerces the numeric fields in place and returns
// the first problem found, or null when the event is safe to write.
function validateEvent(event) {
  if (typeof event.title !== 'string' || !event.title.trim()) {
    return 'title 为必填项';
  }
  if (!isRealDateTime(event.startAt)) {
    return 'startAt 必须为 YYYY-MM-DDTHH:MM 格式的有效时间';
  }
  if (!isRealDateTime(event.endAt)) {
    return 'endAt 必须为 YYYY-MM-DDTHH:MM 格式的有效时间';
  }
  // Both are the same fixed-width format, so string order is time order — and
  // this is the same rule the events_end_after_start CHECK enforces in SQL.
  if (event.endAt <= event.startAt) {
    return '结束时间必须晚于开始时间';
  }
  event.capacity = Number(event.capacity);
  if (!Number.isInteger(event.capacity) || event.capacity < 0) {
    return 'capacity 必须为非负整数';
  }
  if (event.coords !== null
    && (typeof event.coords !== 'object'
      || !Number.isFinite(event.coords.lat) || !Number.isFinite(event.coords.lng))) {
    return 'coords 必须为 null 或 {lat, lng}';
  }
  event.checkinRadius = Number(event.checkinRadius);
  if (!Number.isInteger(event.checkinRadius) || event.checkinRadius <= 0) {
    return 'checkinRadius 必须为正整数';
  }
  // Coerced in place to the shape its column allows, so what the routes then
  // hand to `db.createEvent`/`updateEvent` is already normalized.
  try {
    event.teamCount = db.normalizeTeamCount(event.teamCount);
  } catch (err) {
    return err.message;
  }
  return null;
}

// 试训/Guest: `event.guestList` is **public** — the event page shows it to every
// member — so nothing is filtered out of the API either. This used to be an
// admin-only list with a `forViewer` filter here to keep the JSON in step with
// the page; it went when the page opened the list up. If it is ever restricted
// again, both this file's API routes and `/event/:id` have to apply the same
// rule, or the names one hides are a fetch away from the other.

// JSON API — no delete; creating is admin-only, editing is not (POC)
app.get('/api/events', requireLoginApi, wrap(async (req, res) => {
  const me = await viewer(req);
  res.json((await db.getEvents()).filter(e => canSee(e, me)));
}));

app.get('/api/events/:id', requireLoginApi, wrap(async (req, res) => {
  const me = await viewer(req);
  const event = await db.getEvent(req.params.id);
  if (!event || !canSee(event, me)) {
    return res.status(404).json({ ok: false, message: '活动不存在' });
  }
  res.json(event);
}));

app.put('/api/events/:id', requireLoginApi, wrap(async (req, res) => {
  const event = await db.getEvent(req.params.id);
  if (!event || !canSee(event, await viewer(req))) {
    return res.status(404).json({ ok: false, message: '活动不存在' });
  }
  // A finished event is fixed: it exists and can be read, so this is a 400 and
  // not the 404 a hidden one answers. It also closes the last way its roster
  // could still move — raising `capacity` promotes off the waitlist.
  if (hasEnded(event)) {
    return res.status(400).json({ ok: false, message: '活动已结束，无法修改' });
  }

  // `date`/`endDate`/`time` are derived from these two by `rowToEvent` and are
  // read-only — writing them would be silently dropped, so they are not listed.
  const EDITABLE_FIELDS = ['title', 'startAt', 'endAt', 'location', 'coords', 'description', 'capacity', 'checkinRadius', 'teamCount'];
  for (const field of EDITABLE_FIELDS) {
    if (req.body[field] !== undefined) event[field] = req.body[field];
  }
  const error = validateEvent(event);
  if (error) return res.status(400).json({ ok: false, message: error });

  await db.updateEvent(event);
  res.json(await db.getEvent(event.id));
}));

// Backs the "添加活动" modal on /calendar. Creating events is an admin power, so
// unlike the edit route above this one is gated — and gated by re-reading the
// role, never by the session's copy.
app.post('/api/events', requireAdminApi, wrap(async (req, res) => {
  const str = v => (typeof v === 'string' ? v.trim() : '');
  const event = {
    title: str(req.body.title),
    startAt: str(req.body.startAt),
    endAt: str(req.body.endAt),
    location: str(req.body.location),
    description: str(req.body.description),
    capacity: req.body.capacity,
    // New events are created without a check-in point; it is picked afterwards
    // from the check-in settings card on the event page.
    coords: req.body.coords === undefined ? null : req.body.coords,
    checkinRadius: req.body.checkinRadius === undefined ? 10 : req.body.checkinRadius,
    // 队伍数量 — 3 unless the form says otherwise, the same value every event
    // written before the field existed reads as.
    teamCount: req.body.teamCount === undefined ? db.DEFAULT_TEAM_COUNT : req.body.teamCount
  };
  const error = validateEvent(event);
  if (error) return res.status(400).json({ ok: false, message: error });

  res.status(201).json(await db.createEvent(event));
}));

app.use((req, res) => res.status(404).render('404', { title: 'Not Found' }));

app.use((err, req, res, next) => {
  console.error(err);
  // A body rejected by express.raw/json never reaches its route, so the size
  // limit would otherwise surface as a bare "服务器错误" — which tells an admin
  // whose photo was refused nothing about why.
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, message: '文件太大，请换一张更小的图片' });
  }
  res.status(500);
  // An /api/* caller wants JSON, not a page it can't parse.
  if (req.path.startsWith('/api/')) {
    return res.json({ ok: false, message: '服务器错误' });
  }
  // The error page is itself a template render and can fail in turn — on a
  // database outage the session middleware throws before the locals are set.
  // Falling back to text is what keeps the original error visible instead of
  // being replaced by "path is not defined" from header.ejs.
  res.render('404', { title: 'Server Error' }, (renderErr, html) => {
    if (!renderErr) return res.send(html);
    console.error(renderErr);
    res.type('text').send('Server Error');
  });
});

// Only start a long-running server when executed directly (local dev / a
// container host). On Netlify the app is driven by netlify/functions/server.js.
// The database schema is provisioned separately from db/schema.sql.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`GSF app running at http://localhost:${PORT}`);
  });
}

module.exports = app;
