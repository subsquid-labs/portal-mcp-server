# Hyperliquid Fills — Query Reference

## Query Structure

Portal Stream API uses POST requests to `/datasets/hyperliquid-fills/stream`.

**Basic Hyperliquid fills query structure:**

```json
{
  "type": "hyperliquidFills",
  "fromBlock": 800000000,
  "toBlock": 800000100,
  "fills": [{
    "coin": ["BTC"]
  }],
  "fields": {
    "fill": {
      "coin": true,
      "side": true,
      "px": true,
      "sz": true,
      "user": true
    }
  }
}
```

**Field explanations:**
- `type: "hyperliquidFills"` - **Required** (not "evm" or "solana")
- `fromBlock/toBlock` - Block range (**dataset starts at block 750000000**)
- `fills` - Array of fill filter objects (use `{}` to match all fills)
- `fields` - Must use `"fill"` key (not "log" or "transaction")

**Fill filter fields:**
- `coin` - Array of coin/pair names (e.g., `["BTC", "ETH"]`)
- `user` - Array of user addresses (e.g., `["0x258a..."]`)
- `side` - Filter by side: `"B"` (buy/bid) or `"A"` (ask/sell)

---

## Examples

### Example 1: Track All BTC Fills in a Block Range

```json
{
  "type": "hyperliquidFills",
  "fromBlock": 800000000,
  "toBlock": 800000100,
  "fills": [{
    "coin": ["BTC"]
  }],
  "fields": {
    "fill": {
      "coin": true,
      "side": true,
      "px": true,
      "sz": true,
      "user": true,
      "dir": true
    },
    "block": {
      "number": true,
      "timestamp": true
    }
  }
}
```

**Dataset:** `hyperliquid-fills`
**Notes:** `px` = execution price (float); `sz` = trade size (float); timestamps are in **milliseconds**

---

### Example 2: Monitor a Specific Trader's Activity

```json
{
  "type": "hyperliquidFills",
  "fromBlock": 800000000,
  "toBlock": 800100000,
  "fills": [{
    "user": ["0x258a0cb38645842d58e893850bae2e4b66c1e6a8"]
  }],
  "fields": {
    "fill": {
      "coin": true,
      "side": true,
      "px": true,
      "sz": true,
      "dir": true,
      "startPosition": true
    },
    "block": {
      "number": true,
      "timestamp": true
    }
  }
}
```

**Notes:**
- `dir` shows: "Open Long", "Open Short", "Close Long", "Close Short", "Long > Short" (position flip), "Short > Long", "Buy"/"Sell" (spot), "Net Child Vaults" (vault settlements)
- `startPosition` shows the user's position size before this fill

---

### Example 3: Analyze Trading PnL for a User

```json
{
  "type": "hyperliquidFills",
  "fromBlock": 800000000,
  "toBlock": 801000000,
  "fills": [{
    "user": ["0x258a0cb38645842d58e893850bae2e4b66c1e6a8"]
  }],
  "fields": {
    "fill": {
      "coin": true,
      "side": true,
      "px": true,
      "sz": true,
      "dir": true,
      "closedPnl": true,
      "fee": true,
      "feeToken": true
    },
    "block": {"timestamp": true}
  }
}
```

**Notes:**
- `closedPnl` is only non-zero for closing trades ("Close Long" / "Close Short")
- `fee` can be negative (maker rebate)
- Net PnL = sum(closedPnl) - sum(fee)

---

## More Examples

### Example 4: Track High-Volume Trades (All Fills with Full Metadata)

**Use case:** Capture all trade fills with complete metadata for comprehensive analysis.

```json
{
  "type": "hyperliquidFills",
  "fromBlock": 800000000,
  "toBlock": 800000050,
  "fills": [{}],
  "fields": {
    "fill": {
      "coin": true,
      "side": true,
      "px": true,
      "sz": true,
      "user": true,
      "dir": true,
      "closedPnl": true,
      "fee": true,
      "feeToken": true,
      "hash": true,
      "oid": true,
      "tid": true,
      "crossed": true,
      "startPosition": true,
      "cloid": true,
      "builderFee": true
    },
    "block": {
      "number": true,
      "timestamp": true
    }
  }
}
```

**Notes:**
- Empty filter `{}` matches all fills (use narrow block ranges to avoid large responses)
- `crossed` indicates whether the order crossed the spread (taker order)
- `hash` is the unique fill hash, `tid` is the trade ID, `oid` is the order ID
- `cloid` is the client-assigned order ID (hex string or null)

---

### Example 5: Monitor Specific Coin with Fee Analysis

**Use case:** Track ETH perpetual fills and analyze fee structures.

```json
{
  "type": "hyperliquidFills",
  "fromBlock": 800000000,
  "toBlock": 800000200,
  "fills": [{
    "coin": ["ETH"]
  }],
  "fields": {
    "fill": {
      "coin": true,
      "side": true,
      "px": true,
      "sz": true,
      "user": true,
      "fee": true,
      "feeToken": true,
      "builderFee": true,
      "crossed": true
    },
    "block": {
      "number": true,
      "timestamp": true
    }
  }
}
```

**Notes:**
- `crossed: true` means taker order (pays fee), `crossed: false` means maker order (may receive rebate)
- Negative `fee` values indicate maker rebates
- `builderFee` is separate from the standard fee and may be null

---

### Example 6: Track Buys vs Sells for a Coin

**Use case:** Monitor only buy-side fills for BTC to track buying pressure.

```json
{
  "type": "hyperliquidFills",
  "fromBlock": 800000000,
  "toBlock": 800000100,
  "fills": [{
    "coin": ["BTC"],
    "side": "B"
  }],
  "fields": {
    "fill": {
      "coin": true,
      "side": true,
      "px": true,
      "sz": true,
      "user": true,
      "dir": true
    },
    "block": {
      "number": true,
      "timestamp": true
    }
  }
}
```

**Notes:**
- `side: "B"` filters for buys only; use `"A"` for sells (asks)
- Combine with `dir` to distinguish between "Open Long" (new position) and "Close Short" (closing)
- To compare buys vs sells, run two queries or use `fills: [{}]` and filter client-side

---

## Fill Fields Reference

| Field | Type | Description |
|-------|------|-------------|
| `coin` | string | Trading pair name (e.g., "BTC", "ETH", "STRK", "@151") |
| `side` | string | `"B"` (buy/bid) or `"A"` (ask/sell) |
| `px` | float | Execution price |
| `sz` | float | Trade size/quantity |
| `user` | string | Trader's 0x address |
| `dir` | string | "Open Long", "Open Short", "Close Long", "Close Short", "Long > Short", "Short > Long", "Buy", "Sell", "Net Child Vaults" |
| `closedPnl` | float | Realized PnL (negative = loss, zero for opens) |
| `fee` | float | Fee amount (negative = rebate) |
| `feeToken` | string | Fee denomination (e.g., "USDC") |
| `hash` | string | Unique fill hash |
| `oid` | integer | Order ID |
| `tid` | integer | Trade ID |
| `crossed` | boolean | Whether order crossed the spread (taker) |
| `startPosition` | float | Position size before this fill |
| `cloid` | string/null | Client order ID |
| `builderFee` | float/null | Builder fee |

---

## Key Concepts

**Portal API endpoint format:**
The raw Portal Stream API endpoint for Hyperliquid fills is:
```
POST https://portal.sqd.dev/datasets/hyperliquid-fills/stream
```
Note the `/stream` suffix — omitting it returns a 404. The request body uses the `fills` filter (NOT wrapped in a `request` object):
```json
{
  "type": "hyperliquidFills",
  "fromBlock": 800000000,
  "toBlock": 800000100,
  "fills": [{}],
  "fields": { "fill": { "coin": true }, "block": { "number": true } }
}
```
The `fills` array contains filter objects directly: `[{ "coin": ["BTC"] }]`, NOT `[{ "request": { "coin": ["BTC"] } }]`. The `request` wrapper is a Pipes SDK concept (`addFill({ request: ... })`), not a Portal API concept.

**Timestamps are in milliseconds** (unlike EVM chains which use seconds):
```json
{"header":{"number":800000000,"timestamp":1763423558592}}
// Divide by 1000 to get Unix seconds
```

**Side values:** `"B"` = Buy (bid), `"A"` = Ask (sell) — single-character codes only.

**Direction values (9 types):**
- Buy + Open = "Open Long"
- Buy + Close = "Close Short"
- Sell + Open = "Open Short"
- Sell + Close = "Close Long"
- Position flip = "Long > Short" or "Short > Long" (close + open in opposite direction)
- Spot trades = "Buy" or "Sell"
- Vault settlements = "Net Child Vaults"

**Coin naming conventions — TradFi vs Crypto classification:**
Hyperliquid lists traditional finance (TradFi) assets alongside crypto. Coin names follow these patterns:
- **Plain names** = crypto: `BTC`, `ETH`, `SOL`, `HYPE`, `DOGE`, `kPEPE`
- **`cash:` prefix** = TradFi (legacy prefix): `cash:TSLA`, `cash:GOLD`, `cash:USA500`
- **`xyz:` prefix** = TradFi (newer prefix): `xyz:GOLD`, `xyz:SILVER`, `xyz:PLATINUM`, `xyz:XYZ100`, `xyz:TSLA`
- **`@NNN` format** = HIP-3 permissionless market listings: `@230`, `@107`, `@156`

Some plain-name tickers are actually TradFi equities/ETFs on Hyperliquid (no prefix):
`HOOD`, `GOOGL`, `TSM`, `NATGAS`, `PLATINUM`, `EWY`, `EWJ`, `CRWV`, `SNDK`, `SKHX`

For classification in indexers, use pattern matching:
```javascript
function isTradFi(coin) {
  return coin.startsWith('cash:') || coin.startsWith('xyz:')
    || ['HOOD','GOOGL','TSM','NATGAS','PLATINUM','EWY','EWJ','CRWV','SNDK','SKHX'].includes(coin);
}
function isHip3(coin) { return coin.startsWith('@'); }
```

---

## Common Mistakes

### Mistake 1: Using Wrong Type Field

```json
{"type": "evm"}  // Wrong - this is not an EVM dataset
```
**Fix:** Always use `"type": "hyperliquidFills"`.

---

### Mistake 2: Using Seconds Instead of Milliseconds

Hyperliquid timestamps are in **milliseconds**. Divide by 1000 when comparing with Unix timestamps.

---

### Mistake 3: Using Full Side Names

```json
{"fills": [{"side": "buy"}]}  // Wrong
```
**Fix:** Use `"B"` for buy, `"A"` for sell.

---

### Mistake 4: Using Fields Under Wrong Key

```json
{"fields": {"log": {"coin": true}}}  // Wrong - not EVM
```
**Fix:** Use `"fill"` as the fields key.

---

### Mistake 5: Querying Blocks Before Dataset Start

```json
{"fromBlock": 0}  // Wrong - dataset starts at 750000000
```
**Fix:** Always use `fromBlock >= 750000000`.

---

### Mistake 6: Confusing Hyperliquid Datasets

- `hyperliquid-fills` - Trade fills data (use `"type": "hyperliquidFills"`)
- `hyperliquid-mainnet` - HyperEVM chain (use `"type": "evm"`)
- `hyperliquid-testnet` - HyperEVM testnet (use `"type": "evm"`)

---

### Mistake 7: Wrapping Fill Filters in `request` Object (Portal API)

```json
{"fills": [{"request": {"coin": ["BTC"]}}]}
```
**Fix:** The Portal Stream API takes filter fields directly — `request` is a Pipes SDK wrapper:
```json
{"fills": [{"coin": ["BTC"]}]}
```

---

### Mistake 8: Missing `/stream` Suffix on Portal URL

```
POST https://portal.sqd.dev/datasets/hyperliquid-fills
```
**Fix:** The Portal Stream API requires the `/stream` path:
```
POST https://portal.sqd.dev/datasets/hyperliquid-fills/stream
```

---
## Performance Tips

- **Use specific coin filters** when possible - filtering by `coin` narrows results significantly
- **Use narrow block ranges** for broad queries (e.g., all fills with `{}` filter)
- **Combine filters** - use `coin` + `side` or `coin` + `user` for targeted queries
- **Request only needed fields** - omit `hash`, `cloid`, `builderFee` if not needed
