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

### 1. Install BlueBubbles on the Mac Studio

[BlueBubbles](https://bluebubbles.app) is a free, open-source server that exposes
iMessage over a local API. Download the **Server** app, install it, and in its
settings:

- set a **server password** (you will paste it into the relay config)
- leave the port at **1234** unless you have a reason to change it
- grant it **Full Disk Access** and **Accessibility** when macOS asks — it cannot
  work without them

Check it is up: `curl "http://localhost:1234/api/v1/ping?password=YOUR_PASSWORD"`
should answer `pong`.

### 2. Get a relay token from the dashboard

In the CRM: **Texting → Mac relay → Generate token**. Copy it. It is shown in full
once and is a separate secret from your dashboard password — it unlocks the relay
routes and nothing else.

### 3. Install the relay

```bash
cd /path/to/Mass-hiring/relay
./install.sh          # first run creates the config, then stops
open -e ~/.wp-relay/config.json
```

Fill in `relayToken` and `bluebubblesPassword`, then:

```bash
./install.sh          # second run installs and starts the service
tail -f ~/Library/Logs/wp-relay.log
```

You should see `BlueBubbles answered — ready`, and within half a minute the Texting
page in the dashboard shows the Mac as **online**.

### 4. Grant Node Full Disk Access

Delivery and read receipts come from the Messages database, which macOS protects:

**System Settings → Privacy & Security → Full Disk Access → + →** add your `node`
binary (`which node` tells you where it is).

Texting works without this. You just will not see *delivered* or *read* — only
*sent* and *replied*.

### 5. Keep the Mac awake and logged in

The relay runs as a LaunchAgent, so it only runs while the user is logged in:

- **System Settings → General → Login Items** — turn on automatic login
- **System Settings → Displays → Advanced** — prevent automatic sleeping when the
  display is off. Or from the terminal: `sudo pmset -a sleep 0 disablesleep 1`

The display can sleep. The Mac cannot.

---

## Everyday use

```bash
tail -f ~/Library/Logs/wp-relay.log                 # watch it
launchctl bootout gui/$UID/com.wholesalepayments.wprelay    # stop
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.wholesalepayments.wprelay.plist   # start
open -e ~/.wp-relay/config.json                     # settings
```

Set `"dryRun": true` in the config to watch the whole pipeline run — claiming,
pacing, reporting — with the messages only written to the log instead of sent.
Good for a first test.

---

## How it works

The Mac always calls the CRM; the CRM never calls the Mac. That is why this needs
no open ports, no tunnel, no static IP and no router changes, and why it keeps
working on any network you move the Mac to.

```
every  5s   ask for one message → send it → report the outcome
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
| `BlueBubbles is not answering` | The BlueBubbles server app is not running, the port is wrong, or the password does not match. |
| `The CRM rejected the relay token` | Generate a new token on the Texting page and paste it into `config.json`. |
| `could not read chat.db` | Node does not have Full Disk Access — see step 4. Sending still works. |
| Dashboard shows the Mac offline | The Mac slept, logged out, or lost the network. `tail` the log. |
| `Not reachable on iMessage` on a candidate | That number has no iMessage account. Only a real SMS provider can reach them. |
| Replies arrive with no text | A macOS quirk where the message body is stored in a format the database does not expose directly. The relay reads those through BlueBubbles instead — make sure it is running. |
