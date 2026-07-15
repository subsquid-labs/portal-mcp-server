# Data Validation & Quality Checks

Run these checks after an indexer completes a sync to confirm production readiness.

## Validation Levels

### Level 1: Schema Validation (CRITICAL)

```sql
-- Table exists
SELECT count() FROM system.tables
WHERE database = '<database>' AND name = '<table_name>';

-- Column types
DESCRIBE <database>.<table_name>;
```

**Verify:**
- Table exists
- All expected columns present
- Column types match design
- Indexes created
- Table engine correct

### Level 2: Data Quality (HIGH PRIORITY)

```sql
-- Address format validation
SELECT
  countIf(length(pool_address) != 42) as invalid_length,
  countIf(pool_address NOT LIKE '0x%') as missing_prefix,
  countIf(NOT match(pool_address, '^0x[0-9a-fA-F]{40}$')) as invalid_format
FROM <table_name>;

-- Transaction hash format
SELECT
  countIf(length(transaction_hash) != 66) as invalid_length,
  countIf(transaction_hash NOT LIKE '0x%') as missing_prefix
FROM <table_name>;

-- BigInt values
SELECT
  countIf(amount = '') as empty_amounts,
  countIf(NOT match(amount, '^-?[0-9]+$')) as invalid_numbers
FROM <table_name>;

-- NULLs
SELECT
  countIf(from_address IS NULL) as null_from,
  countIf(to_address IS NULL) as null_to,
  countIf(value IS NULL) as null_value
FROM <table_name>;
```

**Checks:**
- Addresses are 42 chars (`0x` + 40 hex)
- Transaction hashes are 66 chars (`0x` + 64 hex)
- BigInt values are valid numbers
- No unexpected NULLs
- Block numbers in expected range

### Level 3: Completeness (MEDIUM PRIORITY)

```sql
-- Block coverage
SELECT
  MIN(block_number) as min_block,
  MAX(block_number) as max_block,
  COUNT(DISTINCT block_number) as unique_blocks
FROM <table_name>;

-- Detect block gaps
SELECT
  block_number,
  block_number - lag(block_number) OVER (ORDER BY block_number) as gap
FROM (
  SELECT DISTINCT block_number FROM <table_name> ORDER BY block_number
)
WHERE gap > 1;

-- Outliers in event density
SELECT
  block_number,
  COUNT(*) as event_count
FROM <table_name>
GROUP BY block_number
HAVING event_count > 1000
ORDER BY event_count DESC
LIMIT 10;
```

**Checks:**
- Block range matches expected
- No gaps in block sequence
- Event counts reasonable
- No duplicate events (same `tx_hash` + `log_index`)

### Level 4: Consistency (MEDIUM PRIORITY)

```sql
-- Block timestamps are monotonic
SELECT
  block_number,
  block_timestamp,
  lag(block_timestamp) OVER (ORDER BY block_number) as prev_timestamp
FROM (
  SELECT DISTINCT block_number, block_timestamp
  FROM <table_name>
  ORDER BY block_number
)
WHERE block_timestamp < prev_timestamp;
```

**Checks:**
- Block timestamps increase with block numbers
- Log indexes sequential within transactions

## Common Data Quality Issues

### Issue 1: NULL Values in Required Fields
**Cause:** Missing `.toString()` on BigInt values.
**Fix:** `amount: transfer.event.value.toString()` (not the raw BigInt).

### Issue 2: Invalid Address Formats
**Cause:** Incorrect extraction or transformation.
**Fix:** Validate address format in the transformer.

### Issue 3: Block Gaps
**Cause:** Indexer crashed and didn't resume properly.
**Fix:** Clear sync table and restart from the affected block.

## Final Checklist

Before declaring success:

- [ ] Table structure matches design
- [ ] No NULL values in required fields
- [ ] All addresses valid (42 chars, `0x` prefix, hex)
- [ ] All transaction hashes valid (66 chars)
- [ ] Block range complete (no gaps)
- [ ] Data count increasing over time
- [ ] Sample transactions match block explorer

## Hyperliquid Note

For Hyperliquid indexers, Portal cross-reference counts drift from ClickHouse counts because of SDK block batching. Use field-level spot-checks as primary verification, not count comparisons. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) Error Pattern 10.
