#!/usr/bin/env python3
"""Helper: print every chat (group/channel/DM) you're in, with its id.

Use this to find the id of the group you want to watch, then paste it into
SOURCE_CHAT in your .env file. Run it once:

    python list_chats.py
"""

import asyncio
import os
import sys

from telethon import TelegramClient

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
client = TelegramClient(SESSION_NAME, int(API_ID), API_HASH)


async def main() -> None:
    await client.start()
    print(f"{'id':>16}  {'type':<10}  name")
    print("-" * 60)
    async for dialog in client.iter_dialogs():
        if dialog.is_group:
            kind = "group"
        elif dialog.is_channel:
            kind = "channel"
        else:
            kind = "user/dm"
        print(f"{dialog.id:>16}  {kind:<10}  {dialog.name}")


if __name__ == "__main__":
    asyncio.run(main())
