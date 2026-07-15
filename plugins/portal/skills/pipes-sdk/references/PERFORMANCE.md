
# Pipes: Performance Optimizer

Specialized agent for analyzing blockchain indexer performance and suggesting optimizations to reduce sync time while maintaining data completeness.

## When to Use This Skill

Activate when:
- User complains indexer is too slow
- User asks how to speed up sync
- User wants performance analysis
- Sync time is taking hours for a simple use case
- User mentions "slow", "performance", "optimize", or "faster"

## Your Role

Help users optimize their indexers for faster sync times by analyzing configuration, suggesting start blocks, identifying bottlenecks, and recommending efficient filtering strategies.

## Analysis Checklist

### 1. Check Current Configuration

Read `src/index.ts` and identify:
- **Start block**: Is it unnecessarily far back in history?
- **Contract list**: Are they tracking too many contracts?
- **Filtering type**: Address filtering (slow) vs contract filtering (fast)?
- **Block range**: How many blocks will be processed?

### 2. Identify Performance Issues

Common problems:
- Start block is token deployment block (6M) when only recent data needed
- Filtering by wallet address (requires scanning all events)
- Tracking 20+ tokens when only 3-5 are relevant
- No filters applied, processing all events
- Full history sync for testing/validation

### 3. Calculate Expected Sync Time

Use these benchmarks from production indexers:

**Block Processing Speed**:
- Factory pattern (Uniswap V3): 8,000-12,000 blocks/sec
- ERC20 transfers: 9,000-13,000 blocks/sec
- General EVM events: 8,000-12,000 blocks/sec

**Time Estimates**:
- 100K blocks: 10-20 seconds
- 1M blocks: 1-3 minutes
- 5M blocks: 5-15 minutes
- 10M blocks: 10-30 minutes
- 20M blocks: 30-60 minutes

### 4. Check Running Indexer

If indexer is currently running:
- Use Bash to check progress
- Calculate current blocks/sec
- Estimate time remaining
- Identify if it's stuck

## Optimization Strategies

### Strategy 1: Adjust Start Block (FASTEST IMPROVEMENT)

**When to use**: User doesn't need full history

**Implementation**:
```typescript
// Before: Full history from token deployment
range: { from: '6,082,465' }  // USDC deployment (2018)

// After: Recent data only
range: { from: '20,000,000' }  // Last 6 months
```

**Impact**:
- Reduces 14M blocks to 4M blocks
- Sync time: 60 min → 5-10 min (85% faster)

**Guidance**:
- Last 2 weeks: Use `fromBlock: 21,000,000` (1-5 min)
- Last 6 months: Use `fromBlock: 19,000,000` (10-30 min)
- Last year: Use `fromBlock: 17,000,000` (20-40 min)

### Strategy 2: Reduce Contract List

**When to use**: Tracking many tokens but only few are relevant

**Implementation**:
```typescript
// Before: Tracking 20+ tokens
const TRACKED_TOKENS = [
  '0x...', // Token 1
  '0x...', // Token 2
  // ... 18 more
]

// After: Only track high-volume tokens
const TRACKED_TOKENS = [
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
  '0x6b175474e89094c44da98b954eedeac495271d0f', // DAI
]
```

**Impact**: Proportional to number of tokens removed

### Strategy 3: Replace Address Filtering with Contract Filtering

**When to use**: User is filtering by wallet address

**Problem**: Address filtering requires scanning ALL events from ALL contracts
```typescript
// SLOW: Filter by address after fetching everything
.filter((t) => {
  const from = t.event.from.toLowerCase();
  const to = t.event.to.toLowerCase();
  return from === TARGET_ADDRESS || to === TARGET_ADDRESS;
})
```

**Solution**: If they know which contracts the address interacts with, track those specifically:
```typescript
// FAST: Track specific contracts only
contracts: [
  '0xKnownContract1',
  '0xKnownContract2',
]
```

**Impact**: Can be 10-100x faster

**If address filtering is required**:
- Warn user it will be slow (1-2+ hours)
- Suggest starting from recent block (20M+)
- Recommend limiting token list to 3-5 tokens

### Strategy 4: Use Parameter Filtering (Server-Side)

**When to use**: Filtering by indexed event parameters

**Implementation**:
```typescript
// Before: Client-side filtering (fetch all, filter locally)
events: {
  transfer: commonAbis.erc20.events.Transfer,
}
.pipe((transfers) =>
  transfers.filter(t => t.event.from === ADDRESS)
)

// After: Server-side filtering (only fetch relevant)
events: {
  transfer: {
    abi: commonAbis.erc20.events.Transfer,
    filter: { from: [ADDRESS] },  // Indexed parameter only
  },
}
```

**Impact**: Reduces bandwidth and processing time

**Limitation**: Only works for indexed event parameters (topic1, topic2, topic3)

### Strategy 5: Testing Strategy

**For initial development**:
1. Use small block range (1000-5000 blocks)
2. Validate data correctness
3. Expand range incrementally
4. Final run with full range

**Example**:
```typescript
// Phase 1: Test (5 seconds)
range: { from: '21,000,000', to: '21,005,000' }

// Phase 2: Validate (2 minutes)
range: { from: '21,000,000', to: '21,100,000' }

// Phase 3: Production (10 minutes)
range: { from: '20,000,000' }
```

## Monitoring Running Indexers

If indexer is currently running, check:

```bash
# Check if indexer is running
ps aux | grep "npm run dev\|tsx src/index.ts"

# Monitor output (if running in background)
# Use Bash tool with the bash_id
```

Look for:
- Current block number / Total blocks
- Blocks per second
- ETA
- Any errors or warnings

## Performance Benchmarks

Share these real-world benchmarks:

| Indexer | Pattern | Blocks | Speed | Time |
|---------|---------|--------|-------|------|
| **USDC swaps** | Factory (Uniswap V3) | 12M | 8-12k/sec | 15-20 min |
| **Vitalik transfers** | Address filtering | 7.3M | 9-13k/sec | 10-15 min |
| **All Uniswap pools** | Factory pattern | 12M | 8-12k/sec | 30-60 min |

**Key Insight**: Address filtering is NOT slower in blocks/sec, but requires processing more events to find matches.

## Optimization Workflow

1. **Read current config**
   - `src/index.ts` - Check range, contracts, filters
   - Calculate total blocks to process

2. **Identify bottlenecks**
   - Start block too early?
   - Too many contracts?
   - Address filtering?
   - No filters at all?

3. **Suggest optimizations**
   - Prioritize: Start block adjustment (biggest impact)
   - Secondary: Reduce contract list
   - Last resort: If address filtering is required, warn and optimize

4. **Provide implementation**
   - Show exact code changes
   - Estimate performance improvement
   - Give before/after sync times

5. **Testing plan**
   - Quick test with small range
   - Validate correctness
   - Full sync when confident

## Output Format

Provide clear analysis:

```
## Performance Analysis

Current Configuration:
- Start block: 6,082,465 (USDC deployment, 2018)
- Total blocks: ~18M blocks
- Estimated sync time: 60-90 minutes

Bottlenecks Identified:
Start block is unnecessarily old
Contract filtering is efficient
No address filtering

Recommended Optimizations:
1. Adjust start block to 20,000,000 (last 6 months)
   - Reduces to 4M blocks
   - New sync time: 5-10 minutes
   - **85% faster**

2. Keep current contract list (efficient)

3. Test with small range first:
   range: { from: 21,000,000, to: 21,010,000 }

Implementation:
[Show exact code changes]

Expected Results:
Before: 60-90 minutes
After: 5-10 minutes
Improvement: 85% faster
```

## When to NOT Optimize

Don't optimize if:
- Sync is already fast (<10 minutes)
- User needs full historical data
- Current performance meets requirements
- Optimization would lose required data

## Related

- [pipes-sdk SKILL.md](../SKILL.md) — scaffolding, troubleshooting, validation
- [PATTERNS.md](./PATTERNS.md) — performance patterns and benchmarks
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — error patterns and fixes

## Official Subsquid Documentation

- **[llms-full.txt](https://docs.sqd.dev/llms-full.txt)** - Complete performance optimization guide
- **[skill.md](https://docs.sqd.dev/skill.md)** - Portal API performance best practices
- **[EVM OpenAPI Schema](https://docs.sqd.dev/en/ai/evm-openapi)** - Portal API filtering capabilities
- **[Available Datasets](https://portal.sqd.dev/datasets)** - Network-specific performance characteristics
