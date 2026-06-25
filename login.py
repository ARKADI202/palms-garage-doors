#!/usr/bin/env python3
"""One-time interactive login.

The unattended setups (Docker / systemd) can't type in the code Telegram texts
you, so run this ONCE first to create the session file:

    python login.py

It asks for your phone number + login code (and 2FA password if set), then
exits. After that, follow.py can run headless using the saved session.
"""

import asyncio
import os
import sys

from telethon import TelegramClient, utils

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass

API_ID = os.environ.get("TELEGRAM_API_ID", "").strip()
API_HASH = os.environ.get("TELEGRAM_API_HASH", "").strip()
if not API_ID or not API_HASH:
    sys.exit("Set TELEGRAM_API_ID and TELEGRAM_API_HASH first (see README.md).")

SESSION_NAME = os.environ.get("SESSION_NAME", "follow_session").strip()


async def main() -> None:
    async with TelegramClient(SESSION_NAME, int(API_ID), API_HASH) as client:
        me = await client.get_me()
        print(f"✅ Logged in as {utils.get_display_name(me)}.")
        print(f"   Session saved as '{SESSION_NAME}.session'. You can now run follow.py headless.")


if __name__ == "__main__":
    asyncio.run(main())
