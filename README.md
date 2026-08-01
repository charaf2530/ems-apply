# EMS ABRAMS — Application Portal & Console

Rebuilt from the original `server.js` / `bot.js` pair into one merged server, with a
redesigned admin console (analytics, bulk review, keyboard shortcuts, role management)
and a hardened submission flow.

## ⚠️ Security first
Your previous `.env` contained a **live Discord bot token and OAuth client secret in
plaintext**, sitting next to a public GitHub remote. Treat both as compromised:

1. Discord Developer Portal → your app → **Bot** → **Reset Token**.
2. Same app → **OAuth2** → **Reset Secret**.
3. Never commit `.env` — this project's `.gitignore` (add one if missing) should
   include `.env` and `data/*.json`.

## What changed
- `server.js` and `bot.js` merged into a single `server.js` (no more duplicate/diverging logic).
- **MCQ scoring moved server-side** — the old code trusted a client-submitted `mcqScore`, so
  an applicant could edit dev tools and grant themselves a perfect score. Now it's computed
  from a fixed answer key on the server.
- **Role system**: `owner > admin > reviewer > viewer > none`, replacing the flat `ADMIN_IDS`
  allow-list. Manage roles from the Members tab.
- **Admin console rebuilt**: analytics tab (submissions/day, score distribution, approval rate,
  avg review turnaround, top reviewers), bulk accept/reject, per-application notes, keyboard
  shortcuts (`j`/`k` navigate, `a`/`r` accept/reject, `x` select, `/` search, `1`-`4` tabs).
- **Data reset**: `data/applications.json` and `data/users.json` start empty. The old mixed-schema
  files (numeric keys, `EMS-xxxx` keys, inconsistent status casing) are not carried over.
- Removed unused dependencies (`node-fetch`, `passport`, `passport-discord`, `socket.io`) —
  OAuth is done directly with `fetch` (Node 18+ has it built in), and nothing in the app used
  passport or sockets.

## Roadmap progress
- **Phase 1** (Login, Logout, role gate, Profile, Dashboard) — done, see `server.js` auth + `/dashboard`.
- **Phase 3** (EMS Personnel Panel) — done, see below. Visit `/personnel` once logged in.
- Phases 2, 4, 5, 6 — not yet built.

### Phase 3 — EMS Personnel Panel
Available at `/personnel` to anyone with a role of `viewer` or above (i.e. anyone with an EMS rank —
`none` is blocked, same gate as `/dashboard`).
- **Handbook** / **SOP** — read from `data/handbook.json` / `data/sop.json`. Edit those files directly to
  update content (an in-panel editor isn't built yet).
- **Duty Schedule** — a fixed weekly grid (Mon–Sun × Morning/Evening/Night) with per-shift capacity.
  Members claim or drop their own shifts; claims live in `data/schedule.json`.
- **LOA** — members submit a leave request (reason + date range); `reviewer`+ see a pending queue and can
  approve/deny. Records live in `data/loa.json`.
- **Activity Points** — every point change (application approvals, manual adjustments) is now logged to a
  ledger in `data/activity.json`, not just totalled on the user record. `admin`+ can manually adjust a
  member's points with a reason.
- **Audit log** — every review, note edit, role change, LOA decision, and point adjustment is now recorded
  to `data/audit.json` via a shared `logAudit()` helper. No UI for it yet (that's Phase 2's job); it's
  queryable at `GET /api/admin/audit` (`admin`+) in the meantime.

### Documentation, bilingual EN/AR, button improvements
- **Documentation** — the full SOP/handbook site (sidebar nav, chain of command, FAQ) now lives at
  `/documentation`, replacing the old placeholder page.
- **Bilingual EN/AR** — `index.html`, `apply.html`, `dashboard.html`, `personnel.html`, and `403.html` all
  have an EN/عربي toggle (top of the page on public pages, top of the sidebar on the console/panel).
  Preference is remembered per-page in `localStorage`. `apply.html`'s MCQ and open questions are fully
  translated and preserve answers if you switch language mid-form. `dashboard.html`/`personnel.html`
  translate all chrome (nav, titles, table headers, form labels); table *data* (names, statuses, toasts)
  intentionally stays in the language it was entered/generated in — translating live user-submitted content
  automatically wasn't in scope here.
- **Button improvements**:
  - Every action button that hits the network (Accept/Reject, bulk actions, role changes, LOA submit/
    approve/deny, shift claim/unclaim, point adjustments) now disables itself and shows a spinner for the
    duration of the request via a shared `withLoading()` helper, so a double-click can't fire the same
    request twice — this is the client-side counterpart to the server crash fix from before.
  - The apply form's submit button now stays in a disabled "✅ Submitted" state after success instead of
    silently re-enabling.
  - The login button is now a proper Discord-branded button (blurple + logo) instead of a plain text link.
- **Bug fix found while testing this**: the dashboard's stat cards (Total/Pending/Approved/Rejected/Avg
  Score/Members, and the Analytics tab's Approval Rate/Avg Review Time/Submissions) referenced hyphenated
  element IDs as bare JS identifiers (`st_t` instead of `document.getElementById("st-t")`), which silently
  never worked. Fixed — those cards now actually populate.

### Login required to apply, Documentation renamed to Handbook
- **`/apply` now requires a Discord login before submitting.** The page shows a login gate (Discord-branded
  button) until the visitor logs in; once logged in, the free-text "Discord ID" field is gone — the form
  shows their authenticated Discord username instead, and the submission is tied to their session, not to
  whatever they type. `POST /submit` also rejects unauthenticated requests server-side (`401`), and now
  takes the Discord ID from `req.session.user.id` rather than the request body — this closes an existing
  spoofing hole where anyone could previously submit under someone else's Discord ID.
- **"Documentation" is now "Handbook"** everywhere it's user-facing (nav links, page title, sidebar), in
  both languages. The route moved to `/handbook`; the old `/documentation` URL still works and 301-redirects
  to it, so nothing that already links to `/documentation` breaks.

## Setup
```bash
npm install
cp .env.example .env   # fill in TOKEN, CLIENT_ID, CLIENT_SECRET, REVIEW_CHANNEL_ID, OWNER_IDS
npm start
```

Then visit `http://localhost:3000`, apply at `/apply`, and log in at `/auth/discord` with an
account listed in `OWNER_IDS` to reach `/dashboard` with owner access.

## File layout
```
server.js              — Express + discord.js bot, OAuth, roles, admin API
content.json            — landing page copy (Arabic)
data/applications.json  — application records (starts empty)
data/users.json          — points/badges/roles (starts empty)
public/index.html        — landing page
public/apply.html        — application form (server-graded MCQ)
public/dashboard.html    — admin console
public/documentation.html — this info, in-app
public/403.html          — shown to logged-in users without a role
assets/                  — put underwater-medical-center.png here for DM branding (optional)
```
