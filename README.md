# Wholesale Payments · Hiring CRM

A CRM-style dashboard for hiring outreach:

- **Import potential hires** from a Google Sheet (paste the link) or a CSV mass upload, with column mapping and duplicate detection.
- **Email each candidate personally** from your work email — one at a time or in bulk, each message individually personalized ({{firstName}}, {{role}}, …) from a default template you control.
- **Calendly booking link** appended to every email as a "Book a time with me" button.
- **Booking alerts**: when a candidate books on your Calendly, their card flips to "Booked" and a **push notification is sent to your phone**.
- Pipeline view (Not contacted → Emailed → Replied → Booked), activity feed, search and filters.

Themed around the Wholesale Payments logo — Apple system typography, white surfaces, light hues of the logo's navy/blue/green as accents.

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

**b) Google OAuth — full integration (Sheets + Gmail API)**
1. In https://console.cloud.google.com/apis/credentials create an *OAuth client ID* (type: Web application).
2. Add the redirect URI shown on the Settings page (`{your-url}/auth/google/callback`).
3. Enable the *Gmail API* and *Google Sheets API* for the project.
4. Paste the Client ID + Secret into **Settings → Google** and click **Connect Google**.

Emails are sent one-by-one (~1s apart) so each candidate receives an individual, personal message — never a CC/BCC blast.

## 3. Calendly + phone notifications

1. **Booking link**: put your Calendly URL in Settings — it's appended to every outreach email as a booking button.
2. **Phone pushes**: install the free [ntfy](https://ntfy.sh) app (iOS/Android), subscribe to a hard-to-guess topic (e.g. `blake-hiring-8241`), enter the same topic in Settings, and hit *Send test*.
3. **Booking webhook**: so Calendly can tell the app about bookings, the app must be reachable from the internet (deploy it, or tunnel with `ngrok http 3000`). Then paste a Calendly *Personal Access Token* (calendly.com → Integrations → API & webhooks) in Settings and click **Enable booking alerts**. The app registers the webhook and stores the signing key automatically.

When someone books: their pipeline status becomes **Booked**, the activity feed logs it, and your phone gets a push with their name and the interview time.

> Calendly webhooks require a Calendly plan that includes the API (Standard and up).

## Configuration reference

Everything can be set in the Settings UI. Alternatively copy `.env.example` to `.env` for server-side defaults (`PORT`, `BASE_URL`, Google OAuth credentials, SMTP, ntfy topic). Values saved in Settings take precedence.

Data lives in `data/db.json` (candidates, template, settings) and `data/tokens.json` (Google tokens); both are gitignored. Back them up to keep your pipeline.

## Stack

Node 18+, Express, nodemailer (SMTP fallback), vanilla JS frontend — no build step. Google Sheets/Gmail and Calendly are called over plain REST.
