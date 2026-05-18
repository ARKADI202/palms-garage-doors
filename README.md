# Live Financial Dashboard

A real-time markets dashboard that streams straight from the **public
Hyperliquid WebSocket** — no backend, no API keys, no build step. The browser
connects directly to `wss://api.hyperliquid.xyz/ws` and renders:

- **Live Mark Price** — mark / oracle / mid, 24h change, premium, impact
  bid/ask, open interest, 24h volume, hourly + annualized funding.
- **Implied Valuation** — mark × your *Estimated FDS*, plus Δ vs an
  *Initial reference* price you set.
- **Live Trade Tape** — streaming taker prints with a rolling 60s window:
  trades/min, volume/min, and buy vs. sell flow.

## Run it

It's a static page — open it any way you like:

```bash
# simplest: just open the file
open index.html            # macOS  (xdg-open on Linux)

# or serve it (recommended)
python3 -m http.server 8080
# then visit http://localhost:8080
```

No install required. Outbound access to `api.hyperliquid.xyz` (port 443) is
the only network dependency, and it happens from your browser.

## Configure

Use the controls in the top bar (persisted in `localStorage`):

| Field | What it does |
|-------|--------------|
| **Coin** | Any Hyperliquid perp symbol (e.g. `BTC`, `ETH`, `SOL`). |
| **Estimated FDS** | Fully-diluted share/supply count for the implied valuation. |
| **Initial reference ($)** | Baseline price for the "vs init ref" / Δ metrics. |

Click **Apply** (or press Enter) to switch instantly — the socket
re-subscribes without reconnecting.

## How it works

| Concern | Approach |
|---------|----------|
| Price/funding/OI | `activeAssetCtx` subscription |
| Trade tape | `trades` subscription, `side: "B"` = taker buy, `"A"` = taker sell |
| Keepalive | `{ "method": "ping" }` every 30s |
| Resilience | auto-reconnect with exponential backoff (capped at 30s) |

Informational only — not financial advice.
