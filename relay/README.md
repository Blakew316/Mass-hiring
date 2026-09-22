# Text relay for the Mac Studio

Sends the hiring outreach texts as **iMessage**, from your own number, and feeds
delivery receipts, read receipts and replies back into the dashboard — so texting
is tracked the same way email already is.

Apple has no server-side iMessage API. A Mac has to do the sending, which is what
this daemon is for.

---

## Before you start: two things that matter more than the setup

**1. Use a separate Apple ID.** Apple disables iMessage on accounts that send a lot
of messages to people who never wrote first. It is not a published limit, but the
consistent experience is that roughly **100 a day is the ceiling**, and a few hundred
a day gets an account flagged within weeks. If that happens to your personal Apple ID,
iMessage and FaceTime stop working on **all** of your devices.

So: sign this Mac into an Apple ID you created for recruiting, not your own. The
dashboard caps texting at 100/day and defaults to 60 for the same reason.

**2. Texting strangers is regulated differently from emailing them.** Cold email falls
under CAN-SPAM, which is an opt-out regime. Cold texts to mobile numbers fall under
the **TCPA**, which carries statutory damages of **$500–$1,500 per message** and a
private right of action. The relay is built to keep you on the right side of it:
messages only go out between 9am and 7pm **in the recipient's own timezone**, never
on Sundays by default, at a randomised human pace, and anyone who replies "STOP" is
blocked immediately and permanently. Leave those settings alone unless you have a
reason.

**Your personal messages are never touched.** The relay keeps its own list of the
numbers it has texted, in `~/.wp-relay/state.json`, and reads or reports nothing
outside that list. The dashboard independently drops anything from a number that is
not a candidate. Both halves have to agree before a message is recorded.

---

## Setup

### 1. Install the relay

```bash
cd /path/to/Mass-hiring/relay
./install.sh          # first run creates the config, then stops
open -e ~/.wp-relay/config.json
```

Paste in the relay token (dashboard → **Texting → Mac relay → Generate**), then:

```bash
./install.sh          # second run installs and starts the service
tail -f ~/Library/Logs/wp-relay.log
```

Nothing else needs installing. The relay drives **Messages.app**, which is already
on this Mac.

### 2. Allow it to control Messages

The first send will fail until macOS is told this is allowed:

**System Settings → Privacy & Security → Automation →** find whatever runs the
relay (your terminal, or `node`) **→ turn on Messages.**

macOS usually prompts for this the first time. If you miss the prompt the log
says exactly this, and nothing sends until it is granted.

### 3. Grant Full Disk Access

**System Settings → Privacy & Security → Full Disk Access → + →** add your `node`
binary. Find its real path first, because the one on your PATH is usually a
symlink and macOS tracks the file it points at:

```bash
readlink -f "$(which node)"      # e.g. /opt/homebrew/Cellar/node/25.1.0/bin/node
```

In the file picker press **⌘⇧G** and paste that path. Then restart the relay —
the permission is only re-checked when the process starts:

```bash
launchctl kickstart -k gui/$UID/com.wholesalepayments.wprelay
```

This one matters more than it sounds. The relay reads the Messages database for
**delivery receipts, read receipts and replies** — all three. Without it you can
send, and you will see nothing come back.

The relay reads that database from inside its own process, using Node's built-in
SQLite. That is deliberate: running `/usr/bin/sqlite3` instead does not work,
because macOS gives Apple-signed system binaries their own permission identity
rather than letting them inherit the relay's, so the read is refused no matter
who you granted Full Disk Access to. The startup log prints which way it is
reading.

### 4. Keep the Mac awake and logged in

The relay runs as a LaunchAgent, so it only runs while the user is logged in:

- **System Settings → General → Login Items** — turn on automatic login
- **System Settings → Displays → Advanced** — prevent automatic sleeping when the
  display is off. Or from the terminal: `sudo pmset -a sleep 0 disablesleep 1`

The display can sleep. The Mac cannot.

### Optional: BlueBubbles instead

The relay can send through a [BlueBubbles](https://bluebubbles.app) server rather
than Messages.app, if you already run one. Set `"backend": "bluebubbles"` in the
config and fill in `bluebubblesUrl` and `bluebubblesPassword`.

There is no advantage for this use, and one real obstacle: Homebrew disabled the
BlueBubbles cask on 2026-09-01 because the app is no longer code-signed, so
installing it means overriding Gatekeeper on an unsigned app that then wants full
access to your message database. The AppleScript backend exists so you do not
have to make that trade.

---

## Everyday use

```bash
wprelay on        # turn texting on
wprelay off       # turn texting off
wprelay status    # is it running, and is it healthy
wprelay log       # watch what it is doing
wprelay restart   # after changing the config
```

**These work over SSH**, so texting can be switched on from a laptop at the
office. One condition: somebody has to be logged in at the Mac Studio itself.
Sending an iMessage means driving Messages.app, and Messages only exists inside
a logged-in desktop session — which is why `wprelay` always talks to the
background service rather than starting the relay in your shell. A relay
started from an SSH shell has no desktop session and every send fails with a
permission error that looks like a bug. Turn on automatic login and this is
never a problem.

Settings live in `~/.wp-relay/config.json` (`open -e ~/.wp-relay/config.json`);
run `wprelay restart` after changing them.

Set `"dryRun": true` in the config to watch the whole pipeline run — claiming,
pacing, reporting — with the messages only written to the log instead of sent.
Good for a first test.

---

## How it works

The Mac always calls the CRM; the CRM never calls the Mac. That is why this needs
no open ports, no tunnel, no static IP and no router changes, and why it keeps
working on any network you move the Mac to.

```
every  5s   ask for one message → send it through Messages → report the outcome
every 20s   look for receipts and replies → report them
every 30s   check in, so the dashboard can show the Mac as online
```

All of the pacing decisions — how fast, how many a day, what hours are acceptable
where the recipient lives — are made by the CRM. The relay deliberately has no
opinion about them, so changing a setting in the dashboard takes effect without
touching this Mac.

**Nothing gets texted twice.** A send is written to `~/.wp-relay/state.json` before
the CRM is told about it, so a crash in that window is recoverable: on restart the
relay reports the send rather than repeating it. If the Mac disappears mid-job, the
CRM takes the message back after three minutes and hands it out again.

---

## When something is wrong

| What you see | What it means |
|---|---|
| `macOS has not granted permission to control Messages` | Step 2 — Automation permission. Nothing sends until it is granted. |
| `No iMessage account is signed in` | Open Messages on the Mac and sign in with the Apple ID you are using for this. |
| `The CRM rejected the relay token` | Generate a new token on the Texting page and paste it into `config.json`. |
| `the Messages database is not readable` | Step 3 — Full Disk Access. Sending still works; receipts and replies do not. |
| Dashboard shows the Mac offline | The Mac slept, logged out, or lost the network. `tail` the log. |
| `No iMessage` on a candidate | Messages accepted the send and then rejected it — that number has no iMessage account. Only a real SMS provider can reach them. |
| Texts send but nothing ever comes back | Almost always Full Disk Access. Check the first few lines of the log. |
| `BlueBubbles is not answering` | Only on the optional BlueBubbles backend: the server app is not running, or the port or password is wrong. |
