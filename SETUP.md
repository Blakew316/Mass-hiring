# Setup guide — official integrations, step by step

This walks through connecting every integration the Hiring CRM uses, in the order that avoids dead ends. Budget about 30–40 minutes for everything.

Everything you enter (API keys, the Google connection, Calendly, your ntfy topic, candidates) is stored **server-side** — in Netlify Blobs when deployed, in `data/` when running locally — never in your browser. Set it up once and it follows you across every browser and device.

**What you need before you start**
- A free **Netlify** account (netlify.com) and a **GitHub** account that has this repository in it. If someone else set the code up, ask them to add you as a collaborator on the repo (or fork it into your account). The first time you import, Netlify asks to install its GitHub app — allow it for this repo.
- Your work Google account (Google Workspace) — or a personal Gmail, with the caveats in Step 1.
- **Calendly on a Standard or higher plan** if you want booking alerts (the booking button itself works on Free).
- A phone for the free ntfy app.

---

## Step 0 — Deploy and lock the dashboard (5 min)

1. Netlify → **Add new project → Import an existing project** → choose the `Mass-hiring` GitHub repo. Build settings are read from `netlify.toml`; leave the defaults. Deploy.
2. **Pick your final site name now**, before Steps 1 and 4: Netlify → **Project configuration → General → Site details → Change site name** (e.g. `wp-hiring`), so your address is `https://wp-hiring.netlify.app`. The Google sign-in and the Calendly webhook are registered against this exact address; if you rename the site or add a custom domain later, you must add the new redirect URI in Google Cloud (Step 1c) and click *Enable booking alerts* again (Step 4).
3. **Set the dashboard password** (the app refuses to run publicly without one): Netlify → **Project configuration → Environment variables → Add a variable** (older Netlify UI: *Site configuration*) → key `APP_PASSWORD`, value = a strong password, leave *Scopes* and *Deploy contexts* at their defaults → **Create variable**. Then **Deploys → Trigger deploy → Deploy site** and wait until the deploy shows *Published*.
4. Open the site. (If you open it before that deploy finishes you'll see **"Lock the dashboard first"** — wait, then click *I've set it — reload*.) Sign in with the password. The Dashboard shows a **Setup checklist** card that ticks itself off as you complete Steps 1–5. Sessions last 30 days per browser; *Sign out* (bottom of the sidebar) signs you out on every device at once, and five wrong passwords lock that address for 15 minutes.

> Netlify Blobs (where your data lives) is included on every Netlify plan and needs no setup. If the dashboard ever shows a red **"Your data is not being saved permanently"** banner, trigger a fresh deploy from the Netlify UI before entering anything else.

---

## Step 1 — Google: private Sheets + sending from your work Gmail + your signature (15 min)

This is the official Google OAuth integration. It gives the app three things at once: read access to your **private** Google Sheets, permission to **send** through the Gmail API as you, and (optionally) read access to your Gmail **signature** so it's appended to every outreach email.

**Which Google account type do you have?**

- **Google Workspace** (a company domain like `you@wholesalepayments.com`) → use the **Internal** audience below. No verification, no test-user list, no expiring connection. Create the Cloud project **while signed in with the work account and under your organization** (the project picker shows the company name, not "No organization") — Internal is only offered for projects inside an organization.
- **Personal @gmail.com** → use the **External** audience with yourself as a test user. It works, with the caveats in 1b.

### 1a. Create the Google Cloud project and enable the APIs
1. Go to https://console.cloud.google.com and sign in with your **work** Google account.
2. Project picker (top bar) → **New project** → name `Hiring CRM` → make sure *Organization/Location* shows your company → Create → make sure it's selected. (No *New project* option or "You need permission to create a project"? Your Workspace admin restricts project creation — ask them to create it or grant you *Project Creator*.)
3. **APIs & Services → Library**. Search and click **Enable** on each of:
   - **Gmail API**
   - **Google Sheets API**

### 1b. Configure the OAuth consent screen
1. Left menu → **Google Auth Platform** (this is where the "OAuth consent screen" moved in 2025; older consoles: *APIs & Services → OAuth consent screen*). Click **Get started** if prompted.
2. **App information**: name `Hiring CRM`, your email as support email.
3. **Audience**:
   - **Internal** (Workspace) — pick this if it's offered. Done; no test users needed.
   - **External** (personal Gmail) — after saving, open **Audience → Test users → Add users** and add your own email. Two caveats:
     (a) While the app is in *Testing*, Google silently expires the connection every **7 days**. The dashboard detects this: the Settings badge turns amber (**connection expired — click Reconnect**) and the sidebar pill reads *Google connection expired — reconnect*. Fix: Settings → Google → **Reconnect** (the *Connect Google* button is relabelled once connected).
     (b) The Gmail-signature permission is a Google *restricted* scope. While the app is in Testing and you're a test user, Google still grants it behind the "unverified app" screen, so you can leave the **Append my Gmail signature** box ticked. Untick it (and *Reconnect*) only if Google's consent page refuses — and don't publish the app to production with it on, which would require a Google security assessment.
4. Contact email → Save/Create. If a **Data Access / Scopes** page is shown you can leave it empty — the app requests exactly what it needs at connect time (`spreadsheets.readonly`, `gmail.send`, `userinfo.email`, plus `gmail.settings.basic` only when the signature box is ticked).

### 1c. Create the OAuth client
1. **Google Auth Platform → Clients → + Create client** (older consoles: *APIs & Services → Credentials → Create credentials → OAuth client ID*).
2. Application type: **Web application**. Name: `Hiring CRM`.
3. Under **Authorized redirect URIs → + Add URI**, paste exactly the redirect URI shown in the dashboard's Settings page (Google card):
   `https://<your-site>.netlify.app/auth/google/callback`
4. Create. A dialog shows the **Client ID** (ends in `.apps.googleusercontent.com`) and the **Client secret** (starts with `GOCSPX-`). Copy both **now** (or *Download JSON*) — Google only shows the secret in full at this moment. If you lose it, open the client and add a new secret.

### 1d. Connect in the dashboard
1. Dashboard → **Settings → Google — Sheets & Gmail**: paste the Client ID into **OAuth Client ID** and the secret into **OAuth Client Secret**. Decide the **"Append my Gmail signature"** box now (see 1b) → **Save settings**.
2. Click **Connect Google** → choose your work account. Personal-Gmail (External) apps first show **"Google hasn't verified this app"** — click **Continue**. On the permissions page tick **every** box (Google lists the Sheets, Gmail-send and signature permissions separately; one left unticked only fails later) → **Continue**. You land back in Settings with the toast *Google connected — you can now import private sheets and send Gmail*, a green **connected · you@company.com** badge (the button now reads **Reconnect**), and the sidebar pill **Sending as you@company.com**. If you instead get a toast starting with *Google sign-in problem: invalid_client*, the Client ID or secret is wrong — re-paste both, **Save settings**, **Connect Google** again.
3. Open **Email Template** (sidebar): with the signature box ticked, the live preview shows your Gmail signature under the booking button and the hint reads *Your Gmail signature (from you@company.com) is added at the bottom automatically.*
   - If it says **"No signature is set on …"**: create one in Gmail first (gear → **See all settings → General → Signature**, set it as the default for new emails, *Save Changes* at the bottom), then Settings → **Reconnect**.
   - If it says **"Couldn't read your Gmail signature"**: Settings → **Reconnect** and tick every permission box.
   Later edits to the signature in Gmail are picked up on the next send automatically. Don't add a sign-off to the template — the signature covers it.

---

## Step 2 — Import candidates from Google Sheets (3 min)

1. Make row 1 the headers — e.g. `Name | Email | Role | Company` (or `First Name | Last Name | Email | …`). Email is the only required column. Columns A–Z and up to 10,000 rows are read. If the list is on a second tab, open that tab before copying the link (the link then ends in `#gid=…`, which the app uses to pick the tab); otherwise the first tab is imported.
2. Dashboard → **Import → Google Sheet**: paste the sheet's URL → **Fetch**. Under the box you'll see **"Loaded via your connected Google account."** if Step 1 worked (or *"Loaded via public link."* for a sheet shared as *Anyone with the link → Viewer*), and a **Map columns** panel with the first 5 rows.
3. Check the mapping (the app guesses it; **Email \*** must not be "— skip —") → **Import candidates**. You're taken to Candidates and a toast reads *Imported 42 candidates (3 skipped)*. Rows without a valid email, or with an email already in the pipeline, are skipped — so re-importing an updated sheet only adds the new people.

CSV works the same way: **Import → CSV upload**.

---

## Step 3 — (Alternative to Step 1 for sending only) Gmail App Password (3 min)

Use this only if you can't do Step 1. It sends over SMTP from your work Gmail, but Gmail does **not** attach your signature to SMTP sends, and private-sheet import stays unavailable.

1. Your Google account needs **2-Step Verification** on: https://myaccount.google.com/security.
2. Go to https://myaccount.google.com/apppasswords → name it `Hiring CRM` → Create → copy the 16-character password. (If the page says the setting isn't available, your Workspace admin has turned app passwords off — use Step 1.)
3. Dashboard → **Settings → Gmail App Password**: enter your work email under *Work email* and the password under *App password* → **Save settings**. The sidebar pill now reads **Sending as you@company.com**.
4. SMTP sends carry no Gmail signature and the default template deliberately has no sign-off — so open **Email Template**, add a blank line and your name/title/phone at the end, and click **Save template**.

If you later connect Google (Step 1), the app sends through Google and ignores the app password.

---

## Step 4 — Calendly: booking link + "someone booked" alerts (5 min)

1. **Booking link**: Calendly → your event type (e.g. *Interview – 30 min*) → **Copy link** → Dashboard **Settings → Calendly → Your Calendly booking link** → **Save settings**. Do this *before* 4.2: if the field is still empty when you enable alerts, the app fills it with your general Calendly page (calendly.com/you), which lists all your event types. Check: **Email Template** → the preview now ends with a **Book a time with me** button and the hint under it names the link.
2. **Webhook (booking alerts)** — this is what flips a candidate to *Booked* and pings your phone. Calendly delivers webhooks on its paid plans (**Standard, Teams, Enterprise** — not Free).
   1. Calendly → **Integrations & apps** (in the newer Calendly layout it sits inside **Automations**) → **API and webhooks** → **Personal access tokens → Get a token / Generate** → name it `Hiring CRM` → copy the token.
   2. Dashboard → **Settings → Calendly → Personal Access Token**: paste it → **Enable booking alerts**.
   3. The app calls Calendly's API to subscribe your Netlify URL (`/webhooks/calendly`) to `invitee.created` and `invitee.canceled`. It generates a random signing key, registers it with the subscription, and stores it so every incoming event is verified; the token itself is used once and discarded. **Dashboard → Recent activity** shows *Registered Calendly webhook at https://…/webhooks/calendly* when it worked. Clicking the button again later is safe — it replaces the old subscription (use this after renaming the site or if bookings stop arriving).
3. **Test it with a test candidate, not a real one**: Candidates → **+ Add manually** → enter your own personal email → **Add candidate**. Open your Calendly link in a private window and book a slot with that same email. (Booking with a real candidate's address would send them a Calendly confirmation.) Wait up to 30 seconds or reload — the dashboard refreshes itself every 30 s: the test candidate's status reads **Booked**, **Dashboard → Recent activity** shows *… booked "Interview – 30 min" — Tue, Sep 8, 10:00 AM CDT* (in your own time zone), and after Step 5 your phone buzzes. Then cancel the booking from Calendly's confirmation email: the status returns to *Emailed* and you get a cancellation push. Finally remove the test candidate with the 🗑 icon on its row.

Matching is by the email the invitee types when booking. If someone books with a different address, the booking is still logged and you're still notified — change their status with the dropdown by hand.

---

## Step 5 — Phone notifications via ntfy (3 min)

1. Install **ntfy** (free, open source): App Store (iOS) or Google Play (Android).
2. In the app: **+ / Subscribe to topic** → enter a topic name nobody would guess, e.g. `wp-hiring-7f3k9` → Subscribe. (Topics aren't password-protected; anyone who knows the name can read it, so keep it random.)
3. Dashboard → **Settings → Phone notifications → ntfy topic**: enter the same topic → **Send test**. A toast reads *Test notification sent — check your phone* and your phone should buzz within a couple of seconds.

From now on, every Calendly booking (and cancellation) sends a push with the candidate's name, role, and interview time in your time zone.

---

## Step 6 — Send your first outreach (2 min)

1. **Email Template** (sidebar): adjust the subject/body if you like → **Save template** (top right); you'll see *Template saved — it's now the default for all outreach*. The button shows a • while you have unsaved edits; edits are kept until you save or reload the page. *Reset to default* brings back the original text. Placeholders `{{firstName}}`, `{{fullName}}`, `{{role}}`, `{{company}}` are filled per candidate (use the *Insert:* buttons under the box). No sign-off needed when Google is connected — your Gmail signature is appended automatically.
2. **Send to everyone**: on the same page, the **Send** card's button *Email all N not contacted* queues the email in the editor for everyone still marked *Not contacted*. Review the message → **Queue N emails**. The server then sends them automatically, about 6 per minute (Settings → *Sending pace*), each person getting their own individual email from your work address — you can close the tab. The **Dashboard** shows a *Sending in progress* card with a progress bar, how many went out in the last 24 hours against your daily limit, any pause Gmail asked for, and **Stop sending** / **Retry N failed** buttons. Gmail allows roughly 2,000 messages per Workspace account per rolling 24 hours (500 on free Gmail); the queue stops at your *Daily send limit* (default 1,800) and resumes by itself the next day. To email specific people instead, tick them on **Candidates** → **Email selected** (8 or fewer go out immediately).
3. Statuses update automatically: *Not contacted → Emailed* on send; **Replied** when the app spots a reply in the Gmail thread (checked every minute while the dashboard is open; also pushed to your phone); *Booked* on a Calendly booking; back to *Emailed* on a cancellation. Opens are recorded via an invisible image in the email and listed in **Dashboard → Candidate updates**. To change a status by hand, pick it from the dropdown in the Status column.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Sign-in page says "Too many attempts" | Five wrong passwords lock that address for 15 minutes. |
| "Lock the dashboard first" screen | `APP_PASSWORD` isn't set in Netlify (or the deploy that picks it up hasn't finished) — Step 0.3. |
| Google: `redirect_uri_mismatch` | The URI in Google Cloud must match the one shown in Settings exactly (https, no trailing slash, same site name). |
| Google: "Access blocked: this app has not been verified" / "hasn't completed the verification process" | External app: add yourself under *Audience → Test users*; if it still refuses, untick the signature box, save, and reconnect. Or use Internal (Workspace). |
| Google: "This app is blocked" / `org_internal` | Your Workspace admin restricts third-party apps, or you signed in with an account outside the organization. Use the work account; ask the admin to allow the OAuth client if needed. |
| Settings badge "connection expired — click Reconnect"; sends fail with *Token has been expired or revoked* | External app in Testing hit the 7-day limit. Settings → Google → **Reconnect**. (Internal/Workspace apps never expire.) |
| Toast "Google sign-in problem: invalid_client …" | The Client ID/secret in Settings is wrong (or belongs to another project). Re-paste both, **Save settings**, **Connect Google**. |
| Google: "Sign-in session expired or did not match" | The sign-in took more than 10 minutes, was finished in a different browser or device than the one where you clicked *Connect Google*, or your browser blocks cookies for the site. Click *Connect Google* again in the same browser. |
| Sheet fetch: "The sheet is not public" | Connect Google (Step 1) or share the sheet as *Anyone with the link*. |
| Sheet fetch: "Google could not open that sheet with the connected account, and it is not shared publicly" | The sheet belongs to someone else. In Google Sheets: **Share** → add the account you connected in Step 1 as *Viewer*, then Fetch again. |
| Wrong rows imported | The first tab was read. Open the right tab in Google Sheets and copy the link from there (it ends in `#gid=…`). |
| "Enable booking alerts" fails | Token wrong/expired, or the Calendly plan doesn't include webhooks (Standard+). |
| Booking didn't show up | Check in order: (1) **Dashboard → Recent activity** contains *Registered Calendly webhook at …* — if not, Step 4.2. (2) The invitee typed the same email as the candidate row; otherwise the booking only appears in the feed with no status change. (3) Free Calendly plans don't send webhooks. (4) Wait 30 s or reload. (5) If the feed shows *Rejected a Calendly webhook call with an invalid signature*, the stored key no longer matches — click **Enable booking alerts** again (it replaces the old subscription). |
| ntfy test doesn't arrive | Topic spelled differently in the app vs. phone; or notifications disabled for ntfy in phone settings. |
| Interview times look wrong | Times use the time zone of the browser you last used the dashboard from; open the dashboard once from the right device and they follow. |
| Red "not being saved permanently" banner | Trigger a fresh deploy in Netlify; if it persists, check the deploy log for Blobs errors. |
| Something else fails and the toast isn't enough | Netlify → your project → **Logs → Functions → api** shows the server-side error for each request. |

## Where your data lives / backups

- **Netlify**: a Netlify Blobs store named `crm-data` attached to your project (candidates, template, settings, Google tokens, the Calendly signing key). It persists across deploys; deleting the project deletes it.
- **Local**: `data/db.json` and `data/tokens.json` (gitignored). Copy them to back up.

Secrets are never shown back in full: the dashboard masks the Google client secret, app password, and Calendly signing key after you save them.
