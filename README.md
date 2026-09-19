# Wholesale Payments · Hiring CRM

A CRM-style dashboard for hiring outreach:

- **Import potential hires** from a Google Sheet (paste the link) or a CSV mass upload, with column mapping and duplicate detection.
- **Email each candidate personally** from your work email — one at a time or in bulk, each message individually personalized ({{firstName}}, {{role}}, …) from a default template you control.
- **Calendly booking link** appended to every email as a "Book a time with me" button.
- **Booking alerts**: when a candidate books on your Calendly, their card flips to "Booked" and a **push notification is sent to your phone**.
- Pipeline view (Not contacted → Emailed → Replied → Booked, plus Bounced), activity feed, search and filters.

Themed around the Wholesale Payments logo — Apple system typography, white surfaces, light hues of the logo's navy/blue/green as accents.

**Full step-by-step integration walkthrough: [SETUP.md](SETUP.md).**

## Quick start

```bash
npm install
npm start          # → http://localhost:3000
```

That's it for browsing the dashboard. The integrations below each take a couple of minutes and can all be configured on the **Settings** page inside the app (no code editing needed).

## 1. Import candidates

- **Google Sheet**: paste the sheet link on the Import page. If the sheet is shared as *"Anyone with the link → Viewer"* it works immediately, with no Google setup. Private sheets work once Google is connected (step 2b).
- **A file**: drag-and-drop or choose a CSV, TSV, TXT or Excel (.xlsx) file on the Import page — exports from Excel (Windows or Mac), Numbers, Google Sheets, Outlook, LinkedIn or any CRM. Any delimiter, encoding or line-ending works, files up to 50,000 rows are read in pieces, and Excel files are read in the browser with no add-ons.
- **Paste**: copy cells straight out of a spreadsheet and paste them into the box under the drop zone.

A header row helps but is optional: columns are recognised from what they contain (a column of email addresses is the email column whatever it is called), and every guess is shown for you to correct. Before anything is imported the page tells you exactly what will happen — how many people are new, how many are already in your list, how many rows repeat inside the file and which rows have no usable email (with the row number and the offending cell). Re-importing a master list is safe and useful: nobody is added twice, and blank details (phone, company, location…) on people already in the list are filled in from the file when the box is ticked. The result shows the same counts afterwards.

Rows whose email cell isn't a single valid address are listed rather than imported, so nothing a spreadsheet contains can end up in a message header.

## 2. Send from your work email (pick ONE)

**a) Gmail App Password — easiest (2 min)**
1. Go to https://myaccount.google.com/apppasswords (requires 2-step verification on the account).
2. Create an app password, then enter your work email + that password in **Settings → Gmail App Password**.

**b) Google OAuth — full integration (Sheets + Gmail API + your signature)**
1. In https://console.cloud.google.com/apis/credentials create an *OAuth client ID* (type: Web application).
2. Add the redirect URI shown on the Settings page (`{your-url}/auth/google/callback`).
3. Enable the *Gmail API* and *Google Sheets API* for the project.
4. Paste the Client ID + Secret into **Settings → Google** and click **Connect Google**.

With Google connected and the **"Append my Gmail signature"** box ticked in Settings, the signature configured on your work Gmail account is read from Gmail and appended to every outreach email automatically — there is nothing to type in the app. (Gmail only inserts signatures when you compose in Gmail itself; API and SMTP sends don't get it, so the app does this for you. SMTP/App Password sends can't include it.) Reading the signature uses Google's `gmail.settings.basic` permission, which Google classes as *restricted*: fine for a Workspace "Internal" app, but untick the box if you're using a personal-Gmail "External" app — see SETUP.md.

**Attachments.** The *Account Executive* careers flyer ships with the app and is attached to every outreach email out of the box. On the Email Template page you can remove it (and put it back with *Restore the Account Executive flyer*) or add up to three files of your own (PNG, JPG, GIF, WebP or PDF, 4 MB each; a bigger image is shrunk in the browser first, keeping transparency where it can). Attachments are sent on both the Gmail API and App Password paths and are listed in the preview and the send dialog.

The shipped flyer is a 1,224px-wide copy of the print original — sharp on any screen at about 440 KB instead of 720 KB. Attachments still add up in your own mailbox: every send keeps a copy in *Sent*, so at 1,800 emails a day this flyer costs roughly 1 GB of Gmail storage per day. Clear out old sent mail periodically, or attach something lighter, if your Workspace seat is close to its quota.

Emails are sent one-by-one so each candidate receives an individual, personal message — never a CC/BCC blast. **Email all not-contacted candidates** (on the Email Template page, the Dashboard, or the Candidates page) queues everyone still marked *Not contacted*; a scheduled job on the server then sends them automatically at the pace set in Settings (default 30 a minute, at most 60), so you can close the tab. The Dashboard shows progress and a Stop button.

## Finding new candidates (Apollo)

**Import → Find candidates with Apollo** searches Apollo's database and adds the people it finds straight to the list, with their current role, employer, location and **previous roles** — no spreadsheet in between. Paste an Apollo API key in Settings first (Apollo → Settings → Integrations → API).

- The key has to come from an Apollo account whose plan includes API access: trial and free plans answer `not included in your plan`, and the card says so rather than blaming the key.
- Searching is **free** and only reports how many people match, with a sample. Revealing an email costs **one Apollo credit**, so the second button says how many credits the batch will use and asks before spending them.
- The defaults look for account executives, outside sales reps and business development reps at payments and merchant-services companies in the United States, one to two and a half years into their current job — the window in which people answer recruiting mail most often.
- Anyone already in the list is skipped (their blank details are filled in instead), nobody from your own email domain or company is ever added, and ids already pulled in this browser are not paid for twice.
- Each request reveals at most ten addresses, so a batch of fifty is ten small requests with a progress count, and a failure halfway through still keeps everyone already added.

## Filtering by role

The Candidates page has a **role menu** next to the status chips, listing every role people in your list currently hold with a count each, most common first. Picking one narrows the table, and it combines with the status chips and the search box. People with no role on file get their own entry.

Each row shows what that person did **before** their current job, the search box matches those past roles too, and the **Emailed** tile lists everyone's role, employer and previous roles next to whether they opened the email — so you can see which kind of background actually opens and replies.

### Gmail sending limits (why the queue paces itself)

- Google Workspace allows roughly **2,000 messages per account per rolling 24 hours** (500 on free Gmail). That is Google's ceiling, so the *Daily send limit* in Settings (default 1,800) cannot be set above it. When the limit is reached the queue pauses **until the oldest send in the window is 24 hours old** — the dashboard shows that exact time and says the pause is your daily limit, not a Gmail throttle. Raising the limit in Settings lifts the pause immediately. A list larger than the daily limit therefore always spans more than one day; nothing can send 2,900 emails from one Gmail account in a day.
- Google Workspace also caps unique external recipients at 2,000 per day, so for one-to-one outreach the effective ceiling is about 2,000 new people per day.
- The Gmail API allows 6,000 quota units per minute per user for Cloud projects created after May 2026 (each send costs 100 units, so ~60 sends/minute; older projects get 15,000), and Gmail itself throttles bursts ("User-rate limit exceeded. Retry after …" — the same message it uses when the daily cap is hit, with a retry time hours away). *Emails per minute* (default 30) is therefore capped at **60**: a higher number is stored as 60 and Settings says so when you save, so the dashboard never shows a different pace from the one in Settings. To actually reach the pace, each minute's run sends **several emails in parallel** (up to 6 in flight) inside its 20-second budget instead of one after another. When Gmail asks it to slow down, the queue pauses until the time Gmail gives (or 1, 2, 4… minutes when it gives none) and retries — nothing is marked failed for being throttled.
- A send that fails for a passing reason (a Gmail 5xx, a timeout) no longer pauses the queue for a minute; the run simply ends and the next minute's run carries on, checking the Sent folder first where the outcome was unknown. A send is only started when its full 8-second deadline still fits in the run, because a send cut short cannot be told apart from one that was delivered.
- Gmail refusing on **its own** daily cap is kept apart from your *Daily send limit*: the dashboard says Google is refusing and raising your own limit does not lift that pause. Sends are recorded as they happen, and if the storage write itself fails the run stops early rather than risking the same emails going out twice.
- A send that times out is never blindly repeated: with Google connected the app checks your Sent folder first and only sends if the email really did not go out; over SMTP (App Password) it is listed as failed with a note to check Sent before retrying. Anything else that fails is listed on the dashboard with a *Retry failed* button.
- The pace applies across everything (queue and immediate sends together), and progress is saved after every single email, so a Stop pressed mid-run, a new batch queued mid-run, or a server hiccup can neither lose nor duplicate a send.
- Small sends (8 or fewer) still go out immediately from the browser, with the same retry behaviour.

## Following up

People who were emailed and never replied or booked become **due a follow-up** after a wait (Settings → Sending pace: *Follow up after N days*, default 3; *Follow-ups per person*, default 2). The **Follow up** button on the Dashboard, the Candidates page, the Emailed tile and the Email Template page shows how many are due and sends them the follow-up email — as a **reply in the same conversation** (the subject becomes *Re:* the email they received, with the proper In-Reply-To/References headers, so it lands in the same thread in their inbox), without the attachment. Each person can also be followed up individually from their row. The follow-up text has its own editor and preview on the Email Template page; `{{originalSubject}}` stands for the subject they got. Anyone who replies or books while a follow-up is queued is skipped.

## Opens and replies

- Every email carries an invisible tracking image; when a candidate opens it, the dashboard's **Candidate updates** feed shows "*Name* opened your email". The feed is ordered by when things actually happened (a reply is dated when it was sent, a booking when it was made), even if the app only noticed later.
- With Google connected (and the "signature and detect replies" box ticked), the app checks the Gmail threads of sent emails every minute; a reply flips the candidate to **Replied**, appears in the feed with a preview of what they said, and pushes to your phone. Reading replies uses Gmail's read permission (`gmail.readonly`); if you connected Google before this existed, click **Reconnect** once.
- **Only people count as replies.** Delivery failures ("Address not found", "Undeliverable", mailer-daemon messages) move the candidate to **Bounced** instead, and out-of-office / automatic replies and system notifications are ignored — none of them appear in the feed, the Replied tile or your phone. Anyone the old behaviour wrongly marked as Replied is corrected automatically on the next check, and their feed line is removed.
- Reply text that was recorded before the read permission existed is fetched and filled in automatically, a few at a time.
- The four dashboard tiles are clickable: **Emailed** lists who is still waiting (and whether they opened the email), **Replied** shows each reply's text with a link to the thread in Gmail, **Interviews booked** lists upcoming interviews, and **Candidates** opens the full list.

The feed shows only candidate signals (opened, replied, booked, cancelled) — no connection or import history.

## Interviews synced from Calendly

With a Calendly personal access token saved in Settings, the app pulls your scheduled interviews every few minutes (and on demand with **Sync now** in the Interviews booked tile), matches invitees to candidates, flips them to **Booked**, reverts cancellations, and lists every upcoming interview — including bookings made before the webhook existed. The webhook still delivers instant booking alerts.

Matching is by email first (any address the person has booked with before counts), then by full name when the name is unique in your list — people often book with a work address when the sheet has their personal one. A booking the app still cannot place shows **Link to candidate** in the tile: type part of the name or email, click the person, and the address is remembered for next time.

## Protecting the dashboard

Set an `APP_PASSWORD` environment variable (Netlify: *Project configuration → Environment variables*; locally: `.env`) and the dashboard requires a sign-in (sessions last 30 days; *Sign out* revokes every device; five wrong passwords lock that address for 15 minutes). A public Netlify deploy **refuses to run** until the password is set, because the app can send email from your account.

## 3. Calendly + phone notifications

1. **Booking link**: put your Calendly URL in Settings — it's appended to every outreach email as a booking button.
2. **Phone pushes**: install the free [ntfy](https://ntfy.sh) app (iOS/Android), subscribe to a hard-to-guess topic (e.g. `blake-hiring-8241`), enter the same topic in Settings, and hit *Send test*.
3. **Booking webhook**: so Calendly can tell the app about bookings, the app must be reachable from the internet (deploy it, or tunnel with `ngrok http 3000`). Then paste a Calendly *Personal Access Token* (calendly.com → Integrations & apps → API and webhooks) in Settings and click **Enable booking alerts**. The app registers the webhook with a signing key it generates, and rejects any webhook call that isn't correctly signed.

When someone books: their pipeline status becomes **Booked**, the activity feed logs it, and your phone gets a push with their name and the interview time.

> Calendly webhooks require a paid Calendly plan (Standard, Teams or Enterprise).

## Deploy to Netlify

The repo is Netlify-ready — `netlify.toml` publishes `public/` as the site and runs the Express API as a Netlify Function, with candidates/settings/tokens stored in **Netlify Blobs** (so nothing is lost between deploys).

1. Netlify → *Add new project* → *Import an existing project* → pick this GitHub repo. Build settings are read from `netlify.toml`; nothing to change.
2. Add the `APP_PASSWORD` environment variable (*Project configuration → Environment variables*) and deploy. Open your site URL, sign in — the dashboard loads, and the API works at `/api/*`.
3. In the app's Settings, connect email + Calendly + ntfy as above. The app already knows its public URL (Netlify's `URL` env var), so:
   - the Google OAuth redirect URI shown in Settings is `https://<your-site>.netlify.app/auth/google/callback`
   - "Enable booking alerts" registers the Calendly webhook at `https://<your-site>.netlify.app/webhooks/calendly` — no tunnel needed.

Optional: set `BASE_URL` in Netlify's environment variables if you want a specific address used regardless of the primary domain. When you add a custom domain, Netlify's `URL` changes to it, and so does the Google redirect URI — add the new one to your OAuth client (Settings → Google shows it with a Copy button).

## Configuration reference

Everything can be set in the Settings UI. Alternatively copy `.env.example` to `.env` for server-side defaults (`PORT`, `BASE_URL`, Google OAuth credentials, SMTP, ntfy topic). Values saved in Settings take precedence.

All of your configuration (API keys, Google connection, Calendly, ntfy topic) and your candidates are stored **server-side**, never in the browser, so they persist across browsers, devices and sessions. Locally that's `data/db.json` and `data/tokens.json` (gitignored — back them up to keep your pipeline); on Netlify it's a Netlify Blobs store that survives redeploys.

## Stack

Node 18+, Express, nodemailer (SMTP fallback), vanilla JS frontend — no build step. Google Sheets/Gmail and Calendly are called over plain REST.
