"use strict";

/* ------------------------------------------------------------------ *
 * Live financial dashboard backed by the public Hyperliquid WebSocket.
 * No backend: the browser connects straight to wss://api.hyperliquid.xyz/ws
 * and subscribes to `activeAssetCtx` (mark price context) + `trades`.
 * ------------------------------------------------------------------ */

const WS_URL = "wss://api.hyperliquid.xyz/ws";
const CG_URL = "https://api.coingecko.com/api/v3/companies/public_treasury/bitcoin";
const WINDOW_MS = 60_000;     // rolling window for tape stats
const MAX_ROWS = 40;          // trade rows kept in the table
const PING_MS = 30_000;       // keepalive ping interval
const TREASURY_MS = 300_000;  // CoinGecko holdings refresh interval
const BTC_SUPPLY = 21_000_000;

const cfg = loadConfig();

const state = {
  ws: null,
  connected: false,
  reconnectAttempts: 0,
  reconnectTimer: null,
  pingTimer: null,
  ctx: null,            // latest activeAssetCtx payload for cfg.coin
  btcCtx: null,         // activeAssetCtx for BTC (treasury valuation)
  trades: [],           // recent trades, newest first
  lastPx: null,         // last mark price (for flash direction)
  treasury: null,       // { holdings, currentValueUsd, entryValueUsd, pctSupply }
  treasuryAt: 0,        // last successful CoinGecko fetch (ms)
  treasuryErr: false,   // last fetch failed
  treasuryTimer: null,
};

/* ---------------- config / persistence ---------------- */

function loadConfig() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem("dash.cfg") || "{}"); } catch (_) {}
  const pos = (v, d) => (Number(v) > 0 ? Number(v) : d);
  return {
    coin: (saved.coin || "BTC").toUpperCase(),
    fds: pos(saved.fds, 11_870_000_000),
    ref: pos(saved.ref, 150),
    // Treasury-vs-ETF panel (disclosure data — manual / polled, not streamed).
    company: (saved.company || "MSTR").toUpperCase(),
    baseLabel: saved.baseLabel || "since Apr 2025",
    baseBtc: Number(saved.baseBtc) > 0 ? Number(saved.baseBtc) : 0,
    saylorUsd: pos(saved.saylorUsd, 6_100_000_000),
    etfUsd: pos(saved.etfUsd, 1_700_000_000),
  };
}

function saveConfig() {
  try { localStorage.setItem("dash.cfg", JSON.stringify(cfg)); } catch (_) {}
}

/* ---------------- formatting helpers ---------------- */

function fmtPrice(v) {
  if (!isFinite(v)) return "—";
  const abs = Math.abs(v);
  const dp = abs >= 100 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 5 : 8;
  return v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function fmtRef(v) {
  if (!isFinite(v)) return "—";
  return v.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function fmtUSD(v) {
  if (!isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e12) return "$" + (v / 1e12).toFixed(2) + "T";
  if (a >= 1e9)  return "$" + (v / 1e9).toFixed(2) + "B";
  if (a >= 1e6)  return "$" + (v / 1e6).toFixed(2) + "M";
  if (a >= 1e3)  return "$" + (v / 1e3).toFixed(2) + "K";
  return "$" + v.toFixed(2);
}

function fmtSize(v) {
  if (!isFinite(v)) return "—";
  return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function fmtPct(v, withSign = true) {
  if (!isFinite(v)) return "—";
  const s = withSign && v > 0 ? "+" : "";
  return s + v.toFixed(2) + "%";
}

function fmtSigned(v) {
  if (!isFinite(v)) return "—";
  const sign = v > 0 ? "+" : v < 0 ? "-" : "";
  return sign + fmtUSD(Math.abs(v));
}

function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString("en-US", { hour12: true });
}

function cls(v) { return v >= 0 ? "up" : "down"; }
function num(v) { const n = parseFloat(v); return isFinite(n) ? n : NaN; }
function parseNum(s) { return parseFloat(String(s).replace(/[, _$]/g, "")); }
const $ = (id) => document.getElementById(id);

/* ---------------- websocket lifecycle ---------------- */

function connect() {
  cleanupSocket();
  setConn("wait", "connecting");

  let ws;
  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    scheduleReconnect();
    return;
  }
  state.ws = ws;

  ws.onopen = () => {
    state.connected = true;
    state.reconnectAttempts = 0;
    setConn("on", "live");
    subscribe(ws);
    state.pingTimer = setInterval(() => send(ws, { method: "ping" }), PING_MS);
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    handleMessage(msg);
  };

  ws.onclose = () => {
    state.connected = false;
    setConn("off", "offline");
    clearInterval(state.pingTimer);
    scheduleReconnect();
  };

  ws.onerror = () => { try { ws.close(); } catch (_) {} };
}

function cleanupSocket() {
  clearTimeout(state.reconnectTimer);
  clearInterval(state.pingTimer);
  if (state.ws) {
    state.ws.onopen = state.ws.onmessage = state.ws.onclose = state.ws.onerror = null;
    try { state.ws.close(); } catch (_) {}
    state.ws = null;
  }
}

function scheduleReconnect() {
  const n = Math.min(state.reconnectAttempts++, 5);
  const delay = Math.min(1000 * 2 ** n, 30_000);
  setConn("wait", "reconnecting");
  state.reconnectTimer = setTimeout(connect, delay);
}

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function subscribe(ws) {
  send(ws, { method: "subscribe", subscription: { type: "activeAssetCtx", coin: cfg.coin } });
  send(ws, { method: "subscribe", subscription: { type: "trades", coin: cfg.coin } });
  // Always keep a BTC price feed for the treasury valuation. Skip the
  // duplicate when the user is already viewing BTC.
  if (cfg.coin !== "BTC") {
    send(ws, { method: "subscribe", subscription: { type: "activeAssetCtx", coin: "BTC" } });
  }
}

/* Coin change: reset coin-scoped state and reconnect (also re-evaluates the
 * BTC valuation subscription). The blip is ~1s and keeps this simple. */
function switchCoin() {
  state.ctx = null;
  state.trades = [];
  state.lastPx = null;
  renderAll();
  connect();
}

/* ---------------- message handling ---------------- */

function handleMessage(msg) {
  if (!msg || !msg.channel) return;

  if (msg.channel === "activeAssetCtx" || msg.channel === "activeSpotAssetCtx") {
    const d = msg.data || {};
    const coin = (d.coin || "").toUpperCase();
    if (coin === "BTC") state.btcCtx = d.ctx || null;
    if (coin && coin !== cfg.coin) { renderTreasury(); return; }
    state.ctx = d.ctx || null;
    state.ctxAt = Date.now();
    renderMark();
    renderValuation();
    renderTreasury();
  } else if (msg.channel === "trades") {
    const arr = Array.isArray(msg.data) ? msg.data : [];
    for (const t of arr) ingestTrade(t);
    renderTape();
  }
}

function ingestTrade(t) {
  if (!t || (t.coin && t.coin.toUpperCase() !== cfg.coin)) return;
  const px = parseFloat(t.px);
  const sz = parseFloat(t.sz);
  if (!isFinite(px) || !isFinite(sz)) return;
  // Hyperliquid: side "B" = aggressive buy (taker buy), "A" = aggressive sell.
  const buy = t.side === "B";
  state.trades.unshift({
    t: t.time || Date.now(),
    px, sz,
    notional: px * sz,
    buy,
    id: t.tid,
  });
  if (state.trades.length > 600) state.trades.length = 600;
}

/* ---------------- rendering ---------------- */

function renderAll() {
  renderMark();
  renderValuation();
  renderTape();
  renderTreasury();
}

/* Live BTC mark used to value the treasury stack. */
function btcMark() {
  if (cfg.coin === "BTC") return num(state.ctx && state.ctx.markPx);
  return num(state.btcCtx && state.btcCtx.markPx);
}

function renderMark() {
  const c = state.ctx;
  const px = c ? parseFloat(c.markPx) : NaN;

  const el = $("markPx");
  if (isFinite(px)) {
    el.textContent = "$" + fmtPrice(px);
    el.classList.remove("flash-up", "flash-down");
    if (state.lastPx != null && px !== state.lastPx) {
      void el.offsetWidth; // restart animation
      el.classList.add(px > state.lastPx ? "flash-up" : "flash-down");
    }
    state.lastPx = px;
  } else {
    el.textContent = "$—";
  }

  $("markUpdated").textContent = state.ctxAt
    ? "last update " + fmtTime(state.ctxAt)
    : "awaiting data";

  if (!c) {
    ["mark24h", "markVsRef"].forEach((id) => { $(id).textContent = id === "mark24h" ? "24h —" : "vs init ref —"; });
    ["oraclePx", "midPx", "premium", "prevDayPx", "impactPxs",
     "openInterest", "dayNtlVlm", "funding1h", "fundingAnn", "dayBaseVlm"]
      .forEach((id) => { $(id).textContent = "—"; });
    return;
  }

  const prevDay = parseFloat(c.prevDayPx);
  const chg = px - prevDay;
  const chgPct = (chg / prevDay) * 100;
  const m24 = $("mark24h");
  m24.textContent = `${fmtPct(chgPct)} (${fmtSigned(chg)}) 24h`;
  m24.className = isFinite(chgPct) ? cls(chgPct) : "muted";

  const vsRef = ((px - cfg.ref) / cfg.ref) * 100;
  const vr = $("markVsRef");
  vr.textContent = `${fmtPct(vsRef)} vs init ref $${fmtRef(cfg.ref)}`;
  vr.className = isFinite(vsRef) ? cls(vsRef) : "muted";

  const oracle = parseFloat(c.oraclePx);
  const mid = parseFloat(c.midPx);
  const funding = parseFloat(c.funding);          // hourly rate (fraction)
  const oi = parseFloat(c.openInterest);           // base units
  const impact = Array.isArray(c.impactPxs) ? c.impactPxs : null;

  $("oraclePx").textContent = "$" + fmtPrice(oracle);
  $("midPx").textContent = "$" + fmtPrice(mid);
  $("premium").textContent = fmtPct(parseFloat(c.premium) * 100);
  $("prevDayPx").textContent = "$" + fmtPrice(prevDay);
  $("impactPxs").textContent = impact
    ? `$${fmtPrice(parseFloat(impact[0]))} / $${fmtPrice(parseFloat(impact[1]))}`
    : "—";

  $("openInterest").textContent =
    `${fmtSize(oi)} · ${fmtUSD(oi * px)}`;
  $("dayNtlVlm").textContent = fmtUSD(parseFloat(c.dayNtlVlm));
  $("funding1h").textContent = fmtPct(funding * 100);
  $("fundingAnn").textContent = fmtPct(funding * 24 * 365 * 100);
  $("dayBaseVlm").textContent = `${fmtSize(parseFloat(c.dayBaseVlm))} ${cfg.coin}`;
}

function renderValuation() {
  const c = state.ctx;
  const px = c ? parseFloat(c.markPx) : NaN;

  const implied = px * cfg.fds;
  const initVal = cfg.ref * cfg.fds;
  const delta = implied - initVal;
  const deltaPct = (delta / initVal) * 100;

  const big = $("impliedVal");
  big.textContent = isFinite(implied) ? fmtUSD(implied) : "$—";
  big.className = "bignum " + (isFinite(deltaPct) ? cls(deltaPct) : "");

  $("fdsLine").textContent = `FDS ${cfg.fds.toLocaleString("en-US")} sh`;
  $("initVal").textContent = `init → ${fmtUSD(initVal)}`;

  const vd = $("valDelta");
  vd.textContent = isFinite(delta)
    ? `Δ vs init ${fmtSigned(delta)} (${fmtPct(deltaPct)})`
    : "Δ vs init —";
  vd.className = isFinite(deltaPct) ? cls(deltaPct) : "muted";

  $("fdsConfirm").textContent = "confirmed: " + compactCount(cfg.fds);
  $("refConfirm").textContent = "confirmed: $" + fmtRef(cfg.ref);
}

function compactCount(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, "") + "b";
  if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, "") + "m";
  if (n >= 1e3) return (n / 1e3).toFixed(2).replace(/\.?0+$/, "") + "k";
  return String(n);
}

/* ---------------- treasury vs ETF flows ---------------- *
 * Holdings: polled from CoinGecko (disclosure-driven, ~weekly cadence).
 * Live value: holdings x live BTC mark from the WebSocket.
 * Flow figures ($ bought / ETF net inflows): manual disclosure inputs.    */

async function fetchTreasury() {
  clearTimeout(state.treasuryTimer);
  try {
    const res = await fetch(CG_URL, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const list = Array.isArray(data.companies) ? data.companies : [];
    const tick = cfg.company.toUpperCase();
    const co =
      list.find((c) => (c.symbol || "").toUpperCase().includes(tick)) ||
      list.find((c) => (c.name || "").toUpperCase().includes(tick));
    if (!co) throw new Error("company not found: " + cfg.company);
    state.treasury = {
      name: co.name || cfg.company,
      holdings: num(co.total_holdings),
      currentValueUsd: num(co.total_current_value_usd),
      entryValueUsd: num(co.total_entry_value_usd),
      pctSupply: num(co.percentage_of_total_supply),
    };
    state.treasuryAt = Date.now();
    state.treasuryErr = false;
  } catch (_) {
    state.treasuryErr = true; // keep last good snapshot
  } finally {
    renderTreasury();
    state.treasuryTimer = setTimeout(fetchTreasury, TREASURY_MS);
  }
}

function renderTreasury() {
  const t = state.treasury;
  const px = btcMark();
  const held = t ? t.holdings : NaN;

  const liveValue = isFinite(held) && isFinite(px)
    ? held * px
    : (t ? t.currentValueUsd : NaN);
  const pct = t && isFinite(t.pctSupply)
    ? t.pctSupply
    : (isFinite(held) ? (held / BTC_SUPPLY) * 100 : NaN);
  const delta = cfg.baseBtc > 0 && isFinite(held) ? held - cfg.baseBtc : NaN;
  const deltaVal = isFinite(delta) && isFinite(px) ? delta * px : NaN;

  const mult = cfg.etfUsd > 0 ? cfg.saylorUsd / cfg.etfUsd : NaN;
  const m = $("flowMultiple");
  m.textContent = isFinite(mult) ? mult.toFixed(2) + "×" : "—×";
  m.className = "bignum " + (isFinite(mult) ? (mult >= 1 ? "up" : "down") : "");

  $("flowSummary").textContent =
    `${fmtUSD(cfg.saylorUsd)} ${cfg.company} buys vs ${fmtUSD(cfg.etfUsd)} ETF net inflows · ${cfg.baseLabel}`;

  $("mstrHeld").textContent = isFinite(held) ? `${fmtSize(held)} BTC` : "—";
  $("mstrValue").textContent = fmtUSD(liveValue);
  $("mstrPct").textContent = isFinite(pct) ? pct.toFixed(2) + "%" : "—";
  $("mstrDelta").textContent = isFinite(delta)
    ? `+${fmtSize(delta)} BTC · ${fmtUSD(deltaVal)}`
    : "—";
  $("saylorSpent").textContent = fmtUSD(cfg.saylorUsd);
  $("etfNet").textContent = fmtUSD(cfg.etfUsd);

  let age = "· source pending";
  if (state.treasuryAt) {
    age = "· holdings as of " + fmtTime(state.treasuryAt);
    if (state.treasuryErr) age += " (stale — refresh failed)";
  } else if (state.treasuryErr) {
    age = "· holdings source unavailable";
  }
  $("treasuryAge").textContent = age;
}

function renderTape() {
  const now = Date.now();
  const recent = state.trades.filter((t) => now - t.t <= WINDOW_MS);

  let buyN = 0, sellN = 0, buySz = 0, sellSz = 0, vol = 0;
  for (const t of recent) {
    vol += t.notional;
    if (t.buy) { buyN += t.notional; buySz += t.sz; }
    else { sellN += t.notional; sellSz += t.sz; }
  }

  const last = state.trades[0];
  if (last) {
    const side = last.buy ? "up" : "down";
    $("lpSide").textContent = (last.buy ? "BUY" : "SELL") + " (TAKER)";
    $("lpSide").className = "lp-side " + side;
    $("lpPx").textContent = "$" + fmtPrice(last.px);
    $("lpPx").className = "lp-px " + side;
    $("lpMeta").textContent = `${fmtSize(last.sz)} ${cfg.coin} · ${fmtUSD(last.notional)}`;
    $("lpTime").textContent = fmtTime(last.t);
  }

  $("tps").textContent = String(recent.length);
  $("tpsRate").textContent = recent.length + " /min";
  $("vps").textContent = fmtUSD(vol);
  $("vpsRate").textContent = fmtUSD(vol) + " /min";
  $("buyFlow").textContent = fmtUSD(buyN);
  $("buyFlowSz").textContent = fmtSize(buySz) + " " + cfg.coin;
  $("sellFlow").textContent = fmtUSD(sellN);
  $("sellFlowSz").textContent = fmtSize(sellSz) + " " + cfg.coin;

  const body = $("tapeBody");
  if (!state.trades.length) {
    body.innerHTML = '<tr class="empty"><td colspan="6">waiting for trades…</td></tr>';
    return;
  }

  const rows = state.trades.slice(0, MAX_ROWS);
  const lastId = state._lastTopId;
  const html = rows.map((t) => {
    const side = t.buy ? "up" : "down";
    const fresh = lastId != null && t.id != null && t.id > lastId;
    return `<tr class="${side}${fresh ? " flash" : ""}">
      <td>${fmtTime(t.t)}</td>
      <td class="side-cell">${t.buy ? "BUY" : "SELL"}</td>
      <td class="num">${fmtPrice(t.px)}</td>
      <td class="num">${fmtSize(t.sz)}</td>
      <td class="num">${fmtUSD(t.notional)}</td>
      <td class="num flow-cell">${t.buy ? "▲" : "▼"}</td>
    </tr>`;
  }).join("");
  body.innerHTML = html;
  if (rows.length && rows[0].id != null) state._lastTopId = rows[0].id;
}

/* ---------------- UI wiring ---------------- */

function setConn(kind, label) {
  const c = $("conn");
  c.className = "conn conn--" + kind;
  c.querySelector(".conn-label").textContent = label;
  const live = $("tapeLive");
  live.className = "live " + (kind === "on" ? "live--on" : "live--off");
  live.textContent = kind === "on" ? "● live" : "● " + label;
}

function applyControls() {
  const prevCoin = cfg.coin;
  const coin = $("coinInput").value.trim().toUpperCase();
  const fds = parseFloat($("fdsInput").value.replace(/[, _]/g, ""));
  const ref = parseFloat($("refInput").value.replace(/[, _]/g, ""));

  if (coin) cfg.coin = coin;
  if (isFinite(fds) && fds > 0) cfg.fds = fds;
  if (isFinite(ref) && ref > 0) cfg.ref = ref;
  saveConfig();
  syncInputs();

  if (cfg.coin !== prevCoin) switchCoin();
  else { renderValuation(); renderMark(); renderTreasury(); }
}

function applyTreasury() {
  const prevCompany = cfg.company;
  const company = $("companyInput").value.trim().toUpperCase();
  const baseLabel = $("baseLabelInput").value.trim();
  const baseBtc = parseNum($("baseBtcInput").value);
  const saylorUsd = parseNum($("saylorUsdInput").value);
  const etfUsd = parseNum($("etfUsdInput").value);

  if (company) cfg.company = company;
  cfg.baseLabel = baseLabel || cfg.baseLabel;
  cfg.baseBtc = isFinite(baseBtc) && baseBtc > 0 ? baseBtc : 0;
  if (isFinite(saylorUsd) && saylorUsd > 0) cfg.saylorUsd = saylorUsd;
  if (isFinite(etfUsd) && etfUsd > 0) cfg.etfUsd = etfUsd;
  saveConfig();
  syncInputs();

  if (cfg.company !== prevCompany) fetchTreasury();
  else renderTreasury();
}

function syncInputs() {
  $("coinInput").value = cfg.coin;
  $("fdsInput").value = String(cfg.fds);
  $("refInput").value = String(cfg.ref);
  $("companyInput").value = cfg.company;
  $("baseLabelInput").value = cfg.baseLabel;
  $("baseBtcInput").value = cfg.baseBtc ? String(cfg.baseBtc) : "";
  $("saylorUsdInput").value = String(cfg.saylorUsd);
  $("etfUsdInput").value = String(cfg.etfUsd);
}

function init() {
  syncInputs();
  $("applyBtn").addEventListener("click", applyControls);
  $("applyTreasuryBtn").addEventListener("click", applyTreasury);
  document.querySelectorAll(".ctl input").forEach((el) => {
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") applyControls(); });
  });
  document.querySelectorAll(".minictl input").forEach((el) => {
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") applyTreasury(); });
  });
  // Keep rolling-window stats + live treasury valuation fresh.
  setInterval(() => { renderTape(); renderTreasury(); }, 1000);
  renderAll();
  connect();
  fetchTreasury();
}

document.addEventListener("DOMContentLoaded", init);
