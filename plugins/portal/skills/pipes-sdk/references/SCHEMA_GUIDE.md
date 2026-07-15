# Schema Design Guide

Reference for designing optimal ClickHouse schemas for blockchain data.

## Solidity Type → ClickHouse Type Mapping

| Solidity Type | ClickHouse Type | Reasoning |
|---------------|-----------------|-----------|
| `uint256`, `int256` | `String` | Avoids overflow; use `.toString()` in TypeScript |
| `uint128`, `uint160`, `uint192`, `uint224` | `String` | Too large for native integers |
| `uint64`, `uint96`, `uint112` | `String` | Safer as string (can be large) |
| `uint32` | `UInt32` | Safe as native integer |
| `uint16` | `UInt16` | Safe as native integer |
| `uint8` | `UInt8` | Safe as native integer |
| `int24`, `int32` | `Int32` | Safe as native integer |
| `address` | `FixedString(42)` | Always 42 chars (0x + 40 hex) |
| `bytes32` (tx hash) | `FixedString(66)` | Always 66 chars (0x + 64 hex) |
| `bytes32` (generic) | `String` | Variable length when decoded |
| `bool` | `UInt8` or `Bool` | 0/1 or true/false |
| block timestamp | `DateTime` or `DateTime64(3)` | Use DateTime64(3) for millisecond precision |
| `bytes32` (market ID) | `FixedString(66)` | Same as tx hash — 0x + 64 hex |

## Table Engine Selection

| Use Case | Engine | When to Use |
|----------|--------|-------------|
| **Default blockchain events** | `ReplacingMergeTree(block_timestamp)` | Handles reorgs via deduplication |
| **Additive aggregations** | `SummingMergeTree` | Automatic sum aggregation |
| **Real-time state updates** | `CollapsingMergeTree(sign)` | Rollback via sign=-1 records |
| **No reorg concern** | `MergeTree` | Rare; only for finalized data |

**Default recommendation:** `ReplacingMergeTree(block_timestamp)`

**CLI scaffold default:** the Pipes CLI now generates `CollapsingMergeTree(sign)` tables — each includes a `sign Int8 DEFAULT 1` column and an `INDEX _sqd_rollback_idx block_number TYPE minmax GRANULARITY 1`, not a plain `MergeTree`. This is what makes fork rollbacks propagate through materialized views: the target inserts `sign = -1` cancel rows for rolled-back blocks, and the minmax index keeps the block-range delete cheap. Prefer it over `ReplacingMergeTree` when downstream MVs must stay consistent across reorgs.

## Standard Blockchain Columns (Always Include)

```sql
block_number      UInt32,              -- Ethereum block (fits in 4 bytes)
block_timestamp   DateTime,            -- Block timestamp
transaction_hash  FixedString(66),     -- 0x + 64 hex = 66 chars
log_index         UInt16,              -- Log position in transaction
```

## ORDER BY Strategy

Design ORDER BY based on your primary query pattern:

```sql
-- Pool-specific queries (e.g., Uniswap swaps by pool)
ORDER BY (pool_address, block_number, transaction_hash, log_index)

-- Token-specific queries (e.g., ERC20 transfers by token)
ORDER BY (token_address, block_number, transaction_hash, log_index)

-- Time-series / global analysis
ORDER BY (block_number, transaction_hash, log_index)
```

**Principles:**
1. First column: most commonly filtered field (enables partition pruning)
2. Second column: time-based (block_number or block_timestamp)
3. Last columns: uniqueness (transaction_hash, log_index)

## Indexes

```sql
-- Bloom filter for address lookups (most common)
INDEX addr_idx address_column TYPE bloom_filter

-- Set index for low-cardinality filtering
INDEX status_idx status_column TYPE set(100)
```

Add bloom filter indexes for address fields that will be queried frequently. ORDER BY columns don't need explicit indexes.

## Partitioning Strategy

```sql
PARTITION BY toYYYYMM(block_timestamp)    -- Monthly (100k–1M rows/month)
PARTITION BY toYYYYMMDD(block_timestamp)  -- Daily (1M–10M rows/day)
PARTITION BY toYear(block_timestamp)      -- Yearly (< 100k rows/month)
```

## Example: ERC20 Transfers

```sql
CREATE TABLE erc20_transfers (
  block_number      UInt32,
  block_timestamp   DateTime,
  transaction_hash  FixedString(66),
  log_index         UInt16,
  token_address     FixedString(42),
  from_address      FixedString(42),
  to_address        FixedString(42),
  value             String,              -- uint256 → String to avoid overflow

  INDEX token_idx token_address TYPE bloom_filter,
  INDEX from_idx  from_address  TYPE bloom_filter,
  INDEX to_idx    to_address    TYPE bloom_filter

) ENGINE = ReplacingMergeTree(block_timestamp)
ORDER BY (token_address, block_number, transaction_hash, log_index)
PARTITION BY toYYYYMM(block_timestamp)
```

## Timestamp Handling

**CRITICAL**: choose the column type first, then match the JS value to its precision. There is no blanket "always divide by 1000" rule — the divisor depends on the column's declared precision.

- **`DateTime`** (no precision arg) stores **seconds** since epoch → feed `Math.floor(d.timestamp.getTime() / 1000)`.
- **`DateTime(3)` / `DateTime64(3)`** stores **milliseconds** → feed `d.timestamp.getTime()` undivided. ClickHouse parses the `DateTime(3)` column token as `DateTime64(3)`, so the stored ticks are epoch-**ms** and the raw `getTime()` value is already correct.

```typescript
// Column: DateTime  (seconds)
timestamp: Math.floor(d.timestamp.getTime() / 1000),

// Column: DateTime(3) / DateTime64(3)  (milliseconds) — the CLI default scaffold
timestamp: d.timestamp.getTime(),  // do NOT divide
```

**Both** mismatches produce ~1970 dates: milliseconds into a seconds `DateTime`, *and* seconds into a millisecond `DateTime64(3)` (e.g. `1782669669` → `1970-01-21`). So a `1970-01-28`-style date only tells you the precision is mismatched — check the column type before deciding which way to convert.

The `enrichEvents` helper emits **seconds** (matches a plain `DateTime`); the CLI's erc20/uniswap transformers emit `getTime()` ms (matches the `DateTime(3)` columns they generate).

## Struct/Tuple Event Parameters

Some protocols emit events with struct (tuple) parameters. The generated typegen code handles these automatically:

```typescript
// Example: Morpho CreateMarket event with MarketParams tuple
CreateMarket: event(
  '0xac4b2400...',
  'CreateMarket(bytes32,(address,address,address,address,uint256))',
  {
    id: indexed(p.bytes32),
    marketParams: p.struct({
      loanToken: p.address,
      collateralToken: p.address,
      oracle: p.address,
      irm: p.address,
      lltv: p.uint256,
    }),
  },
)
```

Access nested fields in `.pipe()` transforms:
```typescript
d.event.marketParams.loanToken      // address
d.event.marketParams.lltv.toString() // BigInt → String
```

## BigInt Transformation in TypeScript

```typescript
.pipe((events) =>
  events.map((e) => ({
    block_number:     e.block.number,
    block_timestamp:  new Date(e.timestamp).toISOString().replace('Z', ''),
    transaction_hash: e.rawEvent.transactionHash,
    log_index:        e.rawEvent.logIndex,
    from_address:     e.event.from,              // address → already string
    value:            e.event.value.toString(),  // BigInt → String
    tick:             Number(e.event.tick),       // int24 → Number (safe, max ~8M)
  }))
)
```

## Reorg Handling with CollapsingMergeTree

For reorg-sensitive state tracking:

```sql
CREATE TABLE events (
  ...
  sign Int8
) ENGINE = CollapsingMergeTree(sign)
ORDER BY (entity_id, block_number, tx_hash, event_type)
```

```typescript
onRollback: (ctx, range) => {
  const rollbackRecords = events
    .filter(e => e.block >= range.from)
    .map(e => ({ ...e, sign: -1 }))
  return ctx.insert(rollbackRecords)
}
```

**Critical:** ORDER BY must include ALL distinguishing fields to prevent unwanted deduplication.

## Validation Checklist

Before finalizing a schema:
- Every ABI field has a corresponding column (or documented reason for exclusion)
- BigInt fields use `String` type
- Address fields use `FixedString(42)`
- Standard blockchain columns are present
- ORDER BY matches expected query patterns
- Table engine matches reorg requirements
