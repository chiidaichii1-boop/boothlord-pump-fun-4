// Boothlord Pump.fun Paper Sprint — deterministic new-mint momentum bot.
//
// Strategy, in one paragraph: watch every new bonding curve. Buy only a mint that
// is young (seen within the last ~3,600 slots), has real SOL reserves of at least
// 2 SOL, has already run at least 15% above the price where we first saw it, has
// since pulled back to at most 90% of its best price since first seen (buy the
// dip, never chase the spike top — grade-local showed chasing the top bled
// -4.94 SOL on the dev window), and whose recent trades are dominated by buys. Size is ~0.09 SOL, capped at 1% of
// the mint's real SOL reserves (the harness cap) and never below the 0.01 SOL
// round-trip floor the guardrail needs. Exits are mechanical: take profit at
// +60%, stop loss at -30%, trailing stop 20% below the best price since entry,
// or an age limit of 7,200 slots — whichever comes first. Every comparison is
// BigInt cross-multiplication on the curve's virtual reserves, so there is no
// floating point anywhere, no clock, no environment and no randomness: the same
// replay always produces the same orders, byte for byte.
//
// Pump.fun bonding-curve price (SOL per token) is virtual_quote_reserves /
// virtual_token_reserves. A price ratio between two moments is therefore
// (vqr_now * vtr_then) / (vtr_now * vqr_then), compared against a threshold
// (e.g. 115/100) by cross-multiplication.

import { runBot, LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';
import type { BotState, Batch, Curve, OrderInput } from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ tuning

/** Buy at most this old (slots since the mint was first seen). */
const MAX_MINT_AGE_SLOTS = 3_600;
/** Buy only when real SOL reserves are at least this. */
const MIN_REAL_RESERVES = 2n * LAMPORTS_PER_SOL;
/** Buy only when price is at least this far above first-seen price (115 = +15%). */
const MOMENTUM_NUM = 115n;
const MOMENTUM_DEN = 100n;
/** Buy only when at least this many of the last RECENT_TRADES trades were buys. */
const RECENT_TRADES = 10;
const MIN_BUY_TRADES = 7;
const MIN_TRADES_SEEN = 5;
/** Target buy size; the harness cap (1% of real reserves) may shrink it. */
const TARGET_BUY_LAMPORTS = 90_000_000n; // 0.09 SOL
/** A round trip below this does not count toward the 20-mint guardrail. */
const MIN_ROUND_TRIP_LAMPORTS = 10_000_000n; // 0.01 SOL
/** Exit: take profit at +60%. */
const TAKE_PROFIT_NUM = 160n;
const TAKE_PROFIT_DEN = 100n;
/** Exit: stop loss at -30%. */
const STOP_LOSS_NUM = 70n;
const STOP_LOSS_DEN = 100n;
/** Exit: trailing stop 20% below the best price since entry. */
const TRAILING_NUM = 80n;
const TRAILING_DEN = 100n;
/** Entry: buy only after the price has pulled back to at most this share of the
 *  mint's best price since first seen (90 = buy the dip, never chase the top). */
const PULLBACK_NUM = 90n;
const PULLBACK_DEN = 100n;
/** Exit: close a position older than this many slots. */
const MAX_HOLD_SLOTS = 7_200;
/** Slippage tolerance on every order. */
const MAX_SLIPPAGE_BPS = 500;

// ------------------------------------------------------------------ per-mint memory

interface MintMemory {
  /** Virtual reserves when the mint was first seen (price reference). */
  firstVqr: bigint;
  firstVtr: bigint;
  /** Best (highest) price since first seen, as a virtual-reserve fraction. */
  peakVqr: bigint;
  peakVtr: bigint;
  /** Slot the mint was first seen (or its CreateEvent slot). */
  firstSlot: number;
  /** Last RECENT_TRADES trades: true = buy. */
  recentBuys: boolean[];
}

interface EntryMemory {
  /** Virtual reserves when the position first appeared (entry price). */
  entryVqr: bigint;
  entryVtr: bigint;
  /** Best (highest) price seen since entry, as a virtual-reserve fraction. */
  peakVqr: bigint;
  peakVtr: bigint;
  /** Slot the position first appeared. */
  entrySlot: number;
}

/** priceNow / priceRef >= num/den ?  (all BigInt, no floats) */
function priceAtLeast(nowVqr: bigint, nowVtr: bigint, refVqr: bigint, refVtr: bigint, num: bigint, den: bigint): boolean {
  // (nowVqr / nowVtr) / (refVqr / refVtr) >= num / den
  // <=> nowVqr * refVtr * den >= nowVtr * refVqr * num
  return nowVqr * refVtr * den >= nowVtr * refVqr * num;
}

/** priceNow / priceRef <= num/den ? */
function priceAtMost(nowVqr: bigint, nowVtr: bigint, refVqr: bigint, refVtr: bigint, num: bigint, den: bigint): boolean {
  return nowVqr * refVtr * den <= nowVtr * refVqr * num;
}

const mints = new Map<string, MintMemory>();
const entries = new Map<string, EntryMemory>();

function rememberMint(curve: Curve, slot: number): MintMemory {
  let mem = mints.get(curve.mint);
  if (mem === undefined) {
    mem = {
      firstVqr: curve.virtual_quote_reserves,
      firstVtr: curve.virtual_token_reserves,
      peakVqr: curve.virtual_quote_reserves,
      peakVtr: curve.virtual_token_reserves,
      firstSlot: curve.created_slot ?? slot,
      recentBuys: [],
    };
    mints.set(curve.mint, mem);
  }
  // Track the best price since first seen (peak as a fraction vqr/vtr).
  if (curve.virtual_quote_reserves * mem.peakVtr > curve.virtual_token_reserves * mem.peakVqr) {
    mem.peakVqr = curve.virtual_quote_reserves;
    mem.peakVtr = curve.virtual_token_reserves;
  }
  return mem;
}

await runBot({
  onBatch(state: BotState, batch: Batch) {
    const slot = state.slot;

    // 1. Fold this batch's trades into per-mint buy/sell history.
    for (const e of batch.events) {
      if (e.event === 'TradeEvent') {
        const curve = state.curves.get(e.mint);
        if (curve !== undefined) {
          const mem = rememberMint(curve, e.slot);
          mem.recentBuys.push(e.is_buy);
          if (mem.recentBuys.length > RECENT_TRADES) mem.recentBuys.shift();
        }
      } else if (e.event === 'CreateEvent') {
        const curve = state.curves.get(e.mint);
        if (curve !== undefined) rememberMint(curve, e.slot);
      }
    }

    // 2. Drop entry memory for positions that are gone (sold, completed, flattened).
    for (const mint of [...entries.keys()]) {
      if (!state.positions.has(mint)) entries.delete(mint);
    }

    const orders: OrderInput[] = [];

    // 3. Exits first: every held position is checked against TP / SL / trailing / age.
    for (const [mint, holding] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      let entry = entries.get(mint);
      if (entry === undefined) {
        entry = {
          entryVqr: curve.virtual_quote_reserves,
          entryVtr: curve.virtual_token_reserves,
          peakVqr: curve.virtual_quote_reserves,
          peakVtr: curve.virtual_token_reserves,
          entrySlot: slot,
        };
        entries.set(mint, entry);
      }
      const vqr = curve.virtual_quote_reserves;
      const vtr = curve.virtual_token_reserves;

      // Track the best price since entry (peak as a fraction vqr/vtr).
      if (vqr * entry.peakVtr > vtr * entry.peakVqr) {
        entry.peakVqr = vqr;
        entry.peakVtr = vtr;
      }

      const takeProfit = priceAtLeast(vqr, vtr, entry.entryVqr, entry.entryVtr, TAKE_PROFIT_NUM, TAKE_PROFIT_DEN);
      const stopLoss = priceAtMost(vqr, vtr, entry.entryVqr, entry.entryVtr, STOP_LOSS_NUM, STOP_LOSS_DEN);
      const trailing = priceAtMost(vqr, vtr, entry.peakVqr, entry.peakVtr, TRAILING_NUM, TRAILING_DEN);
      const tooOld = slot - entry.entrySlot > MAX_HOLD_SLOTS;

      if (takeProfit || stopLoss || trailing || tooOld) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        entries.delete(mint);
      }
    }

    // 4. Entries: scan curves in first-seen order; buy young, liquid, rising, buy-dominated mints.
    const maxOrders = state.hello.caps.max_orders_per_batch;
    for (const curve of state.curves.values()) {
      if (orders.length >= maxOrders) break;
      if (curve.complete) continue;
      if (state.positions.has(curve.mint)) continue;
      if (entries.has(curve.mint)) continue;
      // A buy already pending on this mint counts as a committed position.
      let pendingBuy = false;
      for (const p of state.pending.values()) {
        if (p.order.side === 'buy' && p.order.mint === curve.mint) {
          pendingBuy = true;
          break;
        }
      }
      if (pendingBuy) continue;
      if (state.committedPositionCount() + orders.filter((o) => o.side === 'buy').length >= state.hello.caps.max_open_positions) {
        break;
      }

      const mem = rememberMint(curve, slot);
      if (slot - mem.firstSlot > MAX_MINT_AGE_SLOTS) continue;
      if (curve.real_quote_reserves < MIN_REAL_RESERVES) continue;

      const cap = state.maxBuyLamports(curve.mint);
      if (cap < MIN_ROUND_TRIP_LAMPORTS) continue;
      const size = cap < TARGET_BUY_LAMPORTS ? cap : TARGET_BUY_LAMPORTS;

      // Momentum: price at least +15% above first-seen price.
      if (
        !priceAtLeast(
          curve.virtual_quote_reserves,
          curve.virtual_token_reserves,
          mem.firstVqr,
          mem.firstVtr,
          MOMENTUM_NUM,
          MOMENTUM_DEN,
        )
      ) {
        continue;
      }

      // Pullback: do not chase the spike top — buy only once the price has
      // retraced to at most 90% of its best price since first seen.
      if (
        !priceAtMost(
          curve.virtual_quote_reserves,
          curve.virtual_token_reserves,
          mem.peakVqr,
          mem.peakVtr,
          PULLBACK_NUM,
          PULLBACK_DEN,
        )
      ) {
        continue;
      }

      // Buy dominance: at least MIN_BUY_TRADES of the last RECENT_TRADES trades were buys.
      const seen = mem.recentBuys.length;
      if (seen < MIN_TRADES_SEEN) continue;
      let buys = 0;
      for (const b of mem.recentBuys) if (b) buys++;
      if (buys < MIN_BUY_TRADES) continue;

      // Cash: keep enough free cash for the size plus its tx fee.
      if (state.freeCashLamports() < size + state.txFeeLamports()) continue;

      orders.push({
        side: 'buy',
        mint: curve.mint,
        quote_lamports: size,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
    }

    return orders;
  },
});
