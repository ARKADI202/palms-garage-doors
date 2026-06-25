#!/usr/bin/env python3
"""Watch a Telegram group/channel as a guest and get notified when ONE person posts.

This is a "userbot": it logs in with YOUR own Telegram account (via the official
API) and listens to a chat you're already a member of. Whenever the target user
posts, it forwards the message to your "Saved Messages", which pushes a
notification to all your devices.

You do NOT need to be an admin of the group, and you don't add anything to it.

First run will ask for your phone number and the login code Telegram sends you.
After that, a local session file keeps you logged in.

See README.md for full setup.
"""

import asyncio
import logging
import os
import sys

from telethon import TelegramClient, events, utils

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    # python-dotenv is optional; env vars can be set by other means.
    pass


def _require(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        sys.exit(
            f"Missing required setting {name}. "
            f"Copy .env.example to .env and fill it in (see README.md)."
        )
    return value


API_ID = int(_require("TELEGRAM_API_ID"))
API_HASH = _require("TELEGRAM_API_HASH")
# The person to follow, given as an @username (the leading @ is optional).
TARGET_USERNAME = _require("TARGET_USERNAME").lstrip("@").lower()
# Optional: restrict to one chat (group/channel id, @username, or invite link).
# Leave blank to match the target in ANY chat you share with them.
SOURCE_CHAT = os.environ.get("SOURCE_CHAT", "").strip()
SESSION_NAME = os.environ.get("SESSION_NAME", "follow_session").strip()

logging.basicConfig(
    format="%(asctime)s  %(levelname)s  %(message)s",
    level=logging.INFO,
    datefmt="%H:%M:%S",
)
log = logging.getLogger("follow")

client = TelegramClient(SESSION_NAME, API_ID, API_HASH)


def _sender_matches(sender) -> bool:
    """True if the message sender's username equals the target username."""
    if sender is None:
        return False
    username = getattr(sender, "username", None)
    if username and username.lower() == TARGET_USERNAME:
        return True
    # A user can also have additional usernames (Telegram "fragment" usernames).
    extra = getattr(sender, "usernames", None) or []
    for u in extra:
        name = getattr(u, "username", None)
        if name and name.lower() == TARGET_USERNAME:
            return True
    return False


async def _notify(event, sender) -> None:
    """Forward the post to Saved Messages, with a header for context."""
    chat = await event.get_chat()
    chat_title = utils.get_display_name(chat) or "a chat"
    display = utils.get_display_name(sender) or f"@{TARGET_USERNAME}"
    header = f"🔔 New post from {display} (@{TARGET_USERNAME}) in {chat_title}"

    try:
        await client.send_message("me", header)
        # Forward the real message so you get the full content + attachments.
        await client.forward_messages("me", event.message)
    except Exception as err:  # e.g. forwarding disabled / protected content
        log.warning("Forward failed (%s); sending a text copy instead.", err)
        text = event.message.message or "[non-text message]"
        await client.send_message("me", f"{header}\n\n{text}")

    log.info("Notified: post from @%s in %s", TARGET_USERNAME, chat_title)


async def main() -> None:
    await client.start()
    me = await client.get_me()
    log.info("Logged in as %s", utils.get_display_name(me))

    chats = None
    if SOURCE_CHAT:
        try:
            entity = await client.get_entity(SOURCE_CHAT)
            chats = [entity]
            log.info("Watching only: %s", utils.get_display_name(entity))
        except Exception as err:
            sys.exit(
                f"Could not resolve SOURCE_CHAT={SOURCE_CHAT!r} ({err}). "
                f"Run `python list_chats.py` to find the right id."
            )
    else:
        log.info("Watching ALL chats you share with @%s", TARGET_USERNAME)

    async def handler(event):
        sender = await event.get_sender()
        if _sender_matches(sender):
            await _notify(event, sender)

    client.add_event_handler(handler, events.NewMessage(chats=chats))

    log.info("Listening for posts from @%s … (Ctrl-C to stop)", TARGET_USERNAME)
    await client.run_until_disconnected()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("Stopped.")
