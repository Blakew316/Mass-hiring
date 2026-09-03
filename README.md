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
- **CSV**: drag-and-drop on the Import page.

First row should be headers — e.g. `Name, Email, Role, Company`. The app guesses the column mapping and lets you correct it before importing.

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

Emails are sent one-by-one so each candidate receives an individual, personal message — never a CC/BCC blast. **Email all not-contacted candidates** (on the Email Template page, the Dashboard, or the Candidates page) queues everyone still marked *Not contacted*; a scheduled job on the server then sends them automatically, a few per minute, so you can close the tab. The Dashboard shows progress and a Stop button.

### Gmail sending limits (why the queue paces itself)

- Google Workspace allows roughly **2,000 messages per account per rolling 24 hours** (500 on free Gmail). The queue stops at the *Daily send limit* in Settings (default 1,800) and resumes by itself as the window frees up.
- Google Workspace also caps unique external recipients at 2,000 per day, so for one-to-one outreach the effective ceiling is about 2,000 new people per day.
- The Gmail API allows 6,000 quota units per minute per user for Cloud projects created after May 2026 (each send costs 100 units, so ~60 sends/minute; older projects get 15,000), and Gmail itself throttles bursts ("User-rate limit exceeded. Retry after …" — the same message it uses when the daily cap is hit, with a retry time hours away). The queue sends *Emails per minute* (default 6) and, when Gmail asks it to slow down, pauses until the time Gmail gives and retries — nothing is marked failed for being throttled.
- A send that times out is never blindly repeated: with Google connected the app checks your Sent folder first and only sends if the email really did not go out; over SMTP (App Password) it is listed as failed with a note to check Sent before retrying. Anything else that fails is listed on the dashboard with a *Retry failed* button.
- The pace applies across everything (queue and immediate sends together), and progress is saved after every single email, so a Stop pressed mid-run, a new batch queued mid-run, or a server hiccup can neither lose nor duplicate a send.
- Small sends (8 or fewer) still go out immediately from the browser, with the same retry behaviour.

## Opens and replies

- Every email carries an invisible tracking image; when a candidate opens it, the dashboard's **Candidate updates** feed shows "*Name* opened your email".
- With Google connected (and the "signature and detect replies" box ticked), the app checks the Gmail threads of sent emails every minute; a reply flips the candidate to **Replied**, appears in the feed with a preview of what they said, and pushes to your phone. Reading replies uses Gmail's read permission (`gmail.readonly`); if you connected Google before this existed, click **Reconnect** once.
- **Only people count as replies.** Delivery failures ("Address not found", "Undeliverable", mailer-daemon messages) move the candidate to **Bounced** instead, and out-of-office / automatic replies and system notifications are ignored — none of them appear in the feed, the Replied tile or your phone. Anyone the old behaviour wrongly marked as Replied is corrected automatically on the next check, and their feed line is removed.
- Reply text that was recorded before the read permission existed is fetched and filled in automatically, a few at a time.
- The four dashboard tiles are clickable: **Emailed** lists who is still waiting (and whether they opened the email), **Replied** shows each reply's text with a link to the thread in Gmail, **Interviews booked** lists upcoming interviews, and **Candidates** opens the full list.

The feed shows only candidate signals (opened, replied, booked, cancelled) — no connection or import history.

## Interviews synced from Calendly

With a Calendly personal access token saved in Settings, the app pulls your scheduled interviews every few minutes (and on demand with **Sync now** in the Interviews booked tile), matches invitees to candidates by email, flips them to **Booked**, reverts cancellations, and lists every upcoming interview — including bookings made before the webhook existed or by people who used a different email (shown as "not in your candidate list"). The webhook still delivers instant booking alerts.

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

Optional: set `BASE_URL` in Netlify's environment variables if you use a custom domain and want that address used instead of the `*.netlify.app` one.

## Configuration reference

Everything can be set in the Settings UI. Alternatively copy `.env.example` to `.env` for server-side defaults (`PORT`, `BASE_URL`, Google OAuth credentials, SMTP, ntfy topic). Values saved in Settings take precedence.

All of your configuration (API keys, Google connection, Calendly, ntfy topic) and your candidates are stored **server-side**, never in the browser, so they persist across browsers, devices and sessions. Locally that's `data/db.json` and `data/tokens.json` (gitignored — back them up to keep your pipeline); on Netlify it's a Netlify Blobs store that survives redeploys.

## Stack

Node 18+, Express, nodemailer (SMTP fallback), vanilla JS frontend — no build step. Google Sheets/Gmail and Calendly are called over plain REST.
