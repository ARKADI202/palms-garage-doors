# palms-garage-doors

Follow **one person** in a Telegram group/channel and get a notification every
time they post — even when you're just a guest (not an admin or owner).

## How it works

You can't add a bot to a group you don't run, so this uses a **userbot**: a tiny
script that logs in with *your own* Telegram account through the official API and
quietly listens to a chat you're already a member of. When your target person
posts, it forwards their message to your **Saved Messages**, which pushes a
notification to every device you're logged in on.

- ✅ No admin rights needed, nothing added to the group.
- ✅ Works for groups and channels you can read.
- ⚠️ It runs as *your* account using your API credentials. Keep `.env` and the
  `*.session` file private (the included `.gitignore` stops them being committed).

## Setup

### 1. Install dependencies

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

### 2. Get your Telegram API credentials

1. Go to https://my.telegram.org and log in with your phone number.
2. Open **API development tools** and create an app (any name).
3. Copy the **api_id** and **api_hash**.

### 3. Configure

```bash
cp .env.example .env
```

Edit `.env` and set:

- `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` — from the step above.
- `TARGET_USERNAME` — the `@username` of the person you want to follow.
- `SOURCE_CHAT` — *(optional)* limit watching to one group. Leave blank to be
  notified whenever the target posts in **any** chat you share with them.

### 4. (Optional) Find the group id

If you want to restrict to one specific group, list your chats and copy its id
into `SOURCE_CHAT`:

```bash
python list_chats.py
```

### 5. Run

```bash
python follow.py
```

The **first** run asks for your phone number and the login code Telegram sends
you (and your 2FA password if you have one). After that it stays logged in via
the local session file. Leave it running — keep notifying.

## Notes

- Matching is by `@username`. If the person changes their username, update
  `TARGET_USERNAME` in `.env` and restart.
- To run it continuously, keep it alive with `tmux`/`screen`, a `systemd`
  service, or any always-on machine.
