# Solana Instructions — Query Reference

## Pre-Build: Estimate Instruction Volume

**Before building an indexer, always verify the program has sufficient instruction volume.** Query Portal for a 10K-slot sample to estimate throughput:

```bash
curl -s 'https://portal.sqd.dev/datasets/solana-mainnet/stream' \
  -H 'content-type: application/json' \
  -H 'accept: application/x-ndjson' \
  -d '{"type":"solana","fromBlock":280000000,"toBlock":280010000,"instructions":[{"programId":["YOUR_PROGRAM_ID"]}],"fields":{"instruction":{"programId":true}}}' \
  | wc -l
```

**Rules of thumb:**
- **< 50 instructions per 10K slots** — very low volume. Investigate if the program is a router that delegates to other programs. Consider indexing the related programs too.
- **50-500 per 10K slots** — moderate. Suitable for indexing but let it sync longer for meaningful data.
- **500+ per 10K slots** — high volume, ideal for indexing.

*Lesson learned:* Sanctum Router had only ~2 instructions per 1K slots because most activity flows through the S Controller (Infinity pool). The Router is just a thin wrapper.

---

## Query Structure

**Basic Solana instruction query structure:**

```json
{
  "type": "solana",
  "fromBlock": 250000000,
  "toBlock": 250001000,
  "instructions": [{
    "programId": ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"],
    "d8": ["0xe445a52e51cb9a1d"],
    "a0": ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"]
  }],
  "fields": {
    "instruction": {
      "programId": true,
      "accounts": true,
      "data": true
    }
  }
}
```

**Field explanations:**
- `type: "solana"` - **Required for Solana chains** (not "evm")
- `fromBlock/toBlock` - Block range using Solana slot numbers (current ~300M+)
- `instructions` - Array of instruction filter objects
- `programId` - Program address (INDEXED - fast)
- `d1/d2/d4/d8` - Discriminators (INDEXED - function selectors)
- `a0-a31` - Account filters by position (INDEXED)
- `mentionsAccount` - Account appears anywhere (INDEXED)

---

## Understanding Discriminators

**Discriminators are Solana's function selectors** (similar to EVM sighash).

**Discriminator types:**
- `d1` - First 1 byte of data (SPL Token Program)
- `d2` - First 2 bytes of data
- `d4` - First 4 bytes of data
- `d8` - First 8 bytes of data (most common for Anchor programs)

### Anchor vs Non-Anchor Programs

**Typegen only works for Anchor programs (d8).** Non-Anchor programs (SPL Token, SPL Stake Pool, System Program) use `d1` single-byte discriminators and require manual decoding. See the `pipes-sdk` skill (specifically `references/TEMPLATES.md`) for the full non-Anchor workflow.

| Program Type | Discriminator | Typegen? | Examples |
|---|---|---|---|
| Anchor | `d8` (8 bytes) | Yes | Orca Whirlpool, Jito Tips, Jupiter Lend |
| Non-Anchor | `d1` (1 byte) | No | SPL Token (`0x03`=Transfer), SPL Stake Pool (`0x0e`=DepositSol) |

### Recommended for Anchor: Use `@subsquid/solana-typegen`

For Anchor programs, use typegen to get correct discriminators automatically:

```bash
# Install
npm install @subsquid/solana-typegen

# Generate from on-chain IDL (Anchor programs)
npx squid-solana-typegen src/abi <PROGRAM_ID>#<program_name>

# Generate from local IDL file
npx squid-solana-typegen src/abi ./idl/program.json
```

**Generated exports:**
```typescript
import * as myProgram from './abi/myProgram'

myProgram.programId              // Program public key
myProgram.instructions.swap.d8   // Correct d8 discriminator
myProgram.instructions.swap.decode(ins)  // Typed decoder → { accounts, data }
myProgram.instructions.swap.accountSelection({ pool: ['<address>'] })  // Account filters
```

Use these in Portal queries:
```json
{
  "programId": ["<from myProgram.programId>"],
  "d8": ["<from myProgram.instructions.swap.d8>"]
}
```

And for decoding raw instruction data in your indexer's `.pipe()` transform:
```typescript
const decoded = myProgram.instructions.swap.decode(ins)
// decoded.accounts — typed account addresses by name
// decoded.data — typed instruction parameters
```

### Manual Discriminator Computation (Fallback Only)

Only use this when typegen fails (non-Anchor programs, custom serialization):

```typescript
import { sha256 } from '@noble/hashes/sha256';

function getDiscriminator(name: string): string {
  const hash = sha256(Buffer.from(`global:${name}`));
  return '0x' + Buffer.from(hash).slice(0, 8).toString('hex');
}
```

**Warning:** Discriminator values are computed from the actual program IDL and may differ between program versions. Always verify against the specific program version or use typegen which reads the correct IDL.

---

## Examples

### Example 1: Track Jupiter Swap Instructions

```json
{
  "type": "solana",
  "fromBlock": 250000000,
  "toBlock": 250001000,
  "instructions": [{
    "programId": ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"],
    "d8": ["0x5703feb8e7573909"]
  }],
  "fields": {
    "instruction": {
      "programId": true,
      "accounts": true,
      "data": true
    },
    "transaction": {
      "feePayer": true,
      "fee": true,
      "err": true
    }
  }
}
```

**Dataset:** `solana-mainnet` | **Program:** Jupiter Aggregator V6 | **Function:** sharedAccountsRoute

---

### Example 2: Track SPL Token Transfers

```json
{
  "type": "solana",
  "fromBlock": 250000000,
  "toBlock": 250001000,
  "instructions": [{
    "programId": ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
    "d1": ["0x03"]
  }],
  "fields": {
    "instruction": {
      "programId": true,
      "accounts": true,
      "data": true
    }
  }
}
```

**Dataset:** `solana-mainnet` | **Program:** SPL Token Program | **Instruction:** Transfer (discriminator: 0x03)
**Notes:** `accounts[0]` = source, `accounts[1]` = destination, `accounts[2]` = authority

---

### Example 3: Track Wallet Activity (All Instructions)

```json
{
  "type": "solana",
  "fromBlock": 250000000,
  "toBlock": 250001000,
  "instructions": [{
    "mentionsAccount": ["9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"]
  }],
  "fields": {
    "instruction": {
      "programId": true,
      "accounts": true,
      "data": true
    },
    "transaction": {
      "feePayer": true,
      "signatures": true
    }
  }
}
```

**Notes:** `mentionsAccount` matches if the account appears ANYWHERE in accounts array. More expensive than `a0-a31` (position-specific) filters.

---

## More Examples

### Example 4: Filter by Specific Account Position

**Use case:** Track instructions where a specific token appears as first account.

```json
{
  "type": "solana",
  "fromBlock": 250000000,
  "toBlock": 250001000,
  "instructions": [{
    "programId": ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"],
    "a0": ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"]
  }],
  "fields": {
    "instruction": {
      "programId": true,
      "accounts": true,
      "data": true
    }
  }
}
```

**Notes:**
- `a0` = first account in accounts array
- `a1` = second account, `a2` = third, etc. (up to a31)
- More efficient than `mentionsAccount`
- Use when you know the account position

---

### Example 5: Track Raydium Pool Interactions

**Use case:** Monitor Raydium AMM swap instructions.

```json
{
  "type": "solana",
  "fromBlock": 250000000,
  "toBlock": 250001000,
  "instructions": [{
    "programId": ["675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"],
    "d8": ["0xf8c69e91e17587c8"]
  }],
  "fields": {
    "instruction": {
      "programId": true,
      "accounts": true,
      "data": true
    }
  }
}
```

**Dataset:** `solana-mainnet`
**Program:** Raydium AMM V4
**Function:** swap (example discriminator)
**Notes:**
- Raydium uses Anchor program (8-byte discriminators)
- `accounts` array includes pool accounts, token accounts, etc.

---

### Example 6: Query Orca Whirlpool Instructions

**Use case:** Monitor all instructions from Orca Whirlpool program with block metadata.

```json
{
  "type": "solana",
  "fromBlock": 280000000,
  "toBlock": 280000003,
  "instructions": [{
    "programId": ["whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"]
  }],
  "fields": {
    "block": {
      "number": true,
      "timestamp": true
    },
    "instruction": {
      "programId": true,
      "accounts": true,
      "data": true,
      "transactionIndex": true
    }
  }
}
```

**Dataset:** `solana-mainnet`
**Program:** Orca Whirlpool

---

### Example 7: Filter Orca Swaps by Discriminator

**Use case:** Isolate specific swap instruction types using 8-byte discriminators.

```json
{
  "type": "solana",
  "fromBlock": 280000000,
  "toBlock": 280000003,
  "instructions": [{
    "programId": ["whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"],
    "d8": ["0xf8c69e91e17587c8"]
  }],
  "fields": {
    "instruction": {
      "programId": true,
      "data": true,
      "accounts": true
    }
  }
}
```

---

### Example 8: Filter Swaps by Specific Pool

**Use case:** Isolate transactions for a particular trading pair (e.g., USDC/SOL pool).

```json
{
  "type": "solana",
  "fromBlock": 280000000,
  "toBlock": 280000003,
  "instructions": [{
    "programId": ["whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"],
    "d8": ["0xf8c69e91e17587c8"],
    "a0": ["7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm"]
  }],
  "fields": {
    "instruction": {
      "programId": true,
      "accounts": true,
      "data": true
    }
  }
}
```

**Pool:** USDC/SOL pool address
**Notes:** Position-based account filters (`a0`-`a31`) are more efficient than protocol-wide queries.

---

### Example 9: Track USDC Token Balance Changes

**Use case:** Monitor USDC token balance changes across blocks.

```json
{
  "type": "solana",
  "fromBlock": 280000000,
  "toBlock": 280000003,
  "fields": {
    "block": {
      "number": true,
      "timestamp": true
    },
    "tokenBalance": {
      "account": true,
      "preMint": true,
      "postMint": true,
      "preAmount": true,
      "postAmount": true,
      "preOwner": true,
      "postOwner": true
    }
  },
  "tokenBalances": [{
    "preMint": ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"]
  }]
}
```

**Token:** USDC (EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v)

---

### Example 10: Monitor Transactions by Fee Payer

**Use case:** Track all transactions from a specific wallet address.

```json
{
  "type": "solana",
  "fromBlock": 280000000,
  "toBlock": 280000003,
  "fields": {
    "transaction": {
      "signatures": true,
      "feePayer": true,
      "err": true
    }
  },
  "transactions": [{
    "feePayer": ["9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"]
  }]
}
```

---

### Example 11: Track Program Deployments

**Use case:** Monitor new program deployments using BPF Upgradeable Loader.

```json
{
  "type": "solana",
  "fromBlock": 270000044,
  "toBlock": 270000047,
  "instructions": [{
    "programId": ["BPFLoaderUpgradeab1e11111111111111111111111"]
  }],
  "fields": {
    "block": {
      "number": true,
      "timestamp": true
    },
    "transaction": {
      "signatures": true,
      "feePayer": true
    },
    "instruction": {
      "programId": true,
      "accounts": true,
      "transactionIndex": true
    }
  }
}
```

**Program:** BPF Upgradeable Loader
**Notes:** First account typically represents the deployed program; fee payer identifies deployer.

---

### Example 12: Track Failed Instructions

**Use case:** Find transactions with failed instructions.

```json
{
  "type": "solana",
  "fromBlock": 250000000,
  "toBlock": 250001000,
  "instructions": [{
    "programId": ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"],
    "isCommitted": false
  }],
  "fields": {
    "instruction": {
      "programId": true,
      "accounts": true,
      "data": true
    },
    "transaction": {
      "err": true,
      "feePayer": true
    }
  }
}
```

**Notes:**
- `isCommitted: false` filters for failed instructions
- `isCommitted: true` filters for successful instructions
- `transaction.err` contains error details

---

## Available Fields

### Instruction Fields

```json
{
  "programId": true,            // Program being called
  "accounts": true,             // Array of account public keys
  "data": true,                 // Instruction data (hex string)
  "computeUnitsConsumed": true, // CU used by this instruction
  "transactionIndex": true,     // Transaction position in block
  "instructionAddress": true,   // Instruction position in transaction
  "isCommitted": true,          // Success/failure status
  "error": true,                // Error details if instruction failed
  "hasDroppedLogMessages": true,// Whether log messages were dropped
  "d1": true,                   // First 1 byte of data
  "d2": true,                   // First 2 bytes of data
  "d4": true,                   // First 4 bytes of data
  "d8": true                    // First 8 bytes of data
}
```

### Transaction Fields

> **COMMON MISTAKE:** The field is `"signatures"` (plural, array) NOT `"signature"`. Using `"signature"` causes an "unknown field" error from Portal.

```json
{
  "feePayer": true,             // Transaction initiator (wallet)
  "fee": true,                  // Transaction fee (lamports)
  "err": true,                  // Error object (null = success)
  "signatures": true,           // Transaction signatures (PLURAL — not "signature")
  "accountKeys": true,          // All account keys in transaction
  "version": true,              // Transaction version
  "computeUnitsConsumed": true, // CU used by transaction
  "addressTableLookups": true,  // Address lookup tables
  "hasDroppedLogMessages": true // Whether log messages were dropped
}
```

---

## INDEXED Fields for Filtering

**Fast filterable fields (use these for filters):**
- `programId` - INDEXED (always filter by this first - most selective)
- `d1, d2, d4, d8` - INDEXED (discriminators)
- `a0` through `a31` - INDEXED (account positions)
- `mentionsAccount` - INDEXED (slower than a0-a31)
- `isCommitted` - INDEXED (success/failure)

**Account filtering strategy:**
- Use `a0-a31` when you know the account position (faster)
- Use `mentionsAccount` when position is unknown or varies

---

## Common Mistakes

### Wrong Discriminator Length

```json
{
  "instructions": [{
    "programId": ["JUP6..."],
    "d1": ["0xe4"]  // Wrong — Jupiter uses d8, not d1
  }]
}
```

**Fix:** Jupiter uses 8-byte discriminators: `"d8": ["0xe445a52e51cb9a1d"]`

---

### Filtering Without programId

```json
{
  "instructions": [{
    "d8": ["0xe445a52e51cb9a1d"]  // Wrong — No programId filter
  }]
}
```

**Fix:** Always filter by `programId` first.

---

### Using EVM-Style Block Numbers

```json
{
  "type": "solana",
  "fromBlock": 19500000  // Wrong — EVM block number, way too low
}
```

**Fix:** Use Solana slot numbers: `"fromBlock": 250000000` (current slot ~300M+)

---

### Forgetting Transaction Fields for Context

Include transaction context when you need fee payer or success status:
```json
{
  "fields": {
    "instruction": {"programId": true, "accounts": true},
    "transaction": {"feePayer": true, "err": true}
  }
}
```

---

## Performance Tips

**Filter selectivity order (best to worst):**
1. `programId` + `d8` + `a0` (best)
2. `programId` + `d8`
3. `programId` + `mentionsAccount`
4. `programId` only

**Block range:** Solana processes ~2 slots/second. 1,000-10,000 slots ≈ 8-80 minutes of data.

---

## Gotchas & Patterns from Production

### LST Tracking: Use Token Mint/Burn, Not Stake Pool Instructions
For liquid staking tokens (jupSOL, dSOL, bSOL), DON'T track SPL Stake Pool instructions directly:
- Operations route through wrapper programs (Sanctum, Jupiter) as CPI calls
- Filtering by a0 = pool account results in very sparse matches = extremely slow scan
- Multiple stake pool program deployments exist

**Instead:** Track SPL Token MintTo/Burn for the LST mint address. Every deposit mints, every withdrawal burns.
- MintTo/MintToChecked: filter with `a0: [LST_MINT]`
- Burn/BurnChecked: filter with `a1: [LST_MINT]` (note: a1 not a0!)

### Anchor d8 Collision Warning
Different programs can share the same d8 for identically-named instructions (e.g., `deposit`). Always combine d8 with programId filter.

### Concurrent Indexer Rate Limiting
Portal returns 429 when 3+ Solana indexers run simultaneously. The Pipes SDK retries automatically with backoff, but ETAs increase 2-3x. Limit to 2-3 concurrent Solana indexers for predictable sync times.

### Scan Speed
Solana scans at ~200-500 blocks/sec regardless of filter specificity. Plan for:
- 3M slots (405M→408M): 2-4 hours
- 38M slots (370M→408M): 10-20 hours
- Node v25 may crash mid-sync; the SDK resumes from checkpoint on restart.
