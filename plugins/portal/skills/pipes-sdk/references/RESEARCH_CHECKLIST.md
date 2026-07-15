# Protocol Research Checklist

A comprehensive guide for researching DeFi protocols before building indexers.

## Quick Reference

### Primary Data Sources (In Order)

1. **Official Documentation** - Protocol docs and GitHub
2. **Block Explorers** - Etherscan/BaseScan verified contracts
3. **Web Search** - General protocol information

## Research Workflow

### Step 1: Official Documentation

Search for:
- Official protocol website
- GitHub repository with source code
- Deployed contract addresses for target chain
- Contract architecture (routers, factories, pools)

**Example searches**:
```
"[Protocol] smart contract documentation"
"[Protocol] deployed contracts ethereum"
"[Protocol] github repository"
```

### Step 2: Verify Contract Addresses

Cross-reference addresses from multiple sources:
- Official documentation
- Block explorer (verified contracts)
- GitHub deployment scripts

**Red flags**:
- Address only found in one source
- No verification on block explorer
- Different addresses across sources

### Step 3: Find Deployment Block

**Methods** (in order of reliability):

1. **Block Explorer** - Look for "Contract Creator" transaction
   - Visit: `https://[chain]scan.org/address/0x...`
   - Find transaction that deployed the contract
   - Note the block number

2. **Conservative Estimate** - If exact block unknown:
   - Use a block from ~1 week before known first activity
   - Better to start earlier than miss events

**DON'T**:
- Spend 5+ attempts trying to web scrape block explorers
- They often block automated access (403 errors)
- Just provide the URL for user to check manually

### Step 4: Extract Event Information

From verified source code or ABI:
- Event names and descriptions
- Full Solidity signatures with types
- Which parameters are indexed
- When each event is emitted

**Where to find**:
- GitHub repository (`.sol` files)
- Block explorer "Contract" tab (if verified)
- ABI JSON (see ABI_GUIDE.md)

### Step 5: Check for Proxy Patterns

**Common gotcha**: Most major DeFi protocols use proxy contracts (Aave, Compound, Lido, USDC, etc.)

**How to detect BEFORE generating the indexer**:
1. Check block explorer for "Proxy" label or "Read as Proxy" tab
2. Check if contract has `implementation()`, `admin()`, or `upgradeTo()` functions
3. Look for `Upgraded` events in the contract's event log

**How to detect AFTER generating the indexer**:
```bash
grep "export const events" src/contracts/*.ts
# If only "Upgraded" event → proxy contract, needs fixing
```

**If proxy**:
1. Find implementation address on Etherscan → "Read as Proxy" tab
2. Generate types from implementation address:
   ```bash
   npx @subsquid/evm-typegen@latest src/contracts \
     <IMPLEMENTATION_ADDRESS> --chain-id <CHAIN_ID>
   ```
3. Update import in `src/index.ts` to use the implementation file
4. Keep the proxy address in `contracts:` array (events emit from proxy)

**Rule of thumb**: If it's a major DeFi protocol, assume it's a proxy until proven otherwise. See `ABI_GUIDE.md` for the full proxy handling workflow.

### Step 6: Identify Key Events

Focus on events that capture:
- **User actions**: deposits, withdrawals, swaps
- **Protocol state**: reserves updates, liquidations
- **Access control**: ownership changes, pauses

**Start with 2-3 core events**, not all events

## Common Patterns by Protocol Type

### DEX (Uniswap, Sushiswap)
- **Factory contract**: Creates pool contracts
- **Pool contracts**: Emit Swap, Mint, Burn events
- **Router contract**: Entry point, but events come from pools

### Lending (Aave, Compound)
- **Pool/Market contract**: Core events (Supply, Borrow, Repay)
- **Oracle contract**: Price updates
- **Liquidation events**: High value for analytics

### Vaults (Yearn, ERC4626)
- **Vault contracts**: Deposit, Withdraw, Transfer events
- **Strategy contracts**: May emit harvest/rebalance events

### Staking (Lido, Rocket Pool)
- **Staking pool**: Deposit/Withdraw events
- **Rewards distribution**: Reward events
- **Token contract**: Transfer events for staked tokens

## Common Gotchas

### 1. Events from Wrong Contract

**Problem**: Filtering main contract but events come from factory

**Example**: Uniswap
- User interacts with **Router**
- Events emitted by **Pool contracts**
- Solution: Index pool contracts, not router

### 2. Proxy vs Implementation

**Problem**: Using proxy ABI, events not decoding

**Solution**:
- Get implementation contract address
- Use implementation ABI
- But filter on proxy address

### 3. Wrong Chain

**Problem**: Researching Ethereum contract, user wants Arbitrum

**Solution**: Always confirm target chain upfront

### 4. Missing Deployment Block

**Problem**: Can't find exact deployment block

**Solution**: Use conservative estimate, user can refine later

## Output Format

After research, present findings as:

```markdown
# [Protocol Name] Research Summary

## Contract Information

### [Primary Contract Name] ([Chain])
- **Address**: `0x...`
- **Deployment Block**: ~X,XXX,XXX (estimated/verified)
- **Type**: Pool/Factory/Router/etc.
- **Source**: [Link to official docs or block explorer]

## Core Events

| Event | Description | Key Parameters |
|-------|-------------|----------------|
| **Event1** | What it tracks | indexed params |
| **Event2** | What it tracks | indexed params |

## Event Signatures

```solidity
event Event1(
    address indexed param1,
    uint256 param2,
    ...
);
```

## Analytics Use Cases

This data enables:
1. **Use Case 1** - Description
2. **Use Case 2** - Description

## Questions Before Proceeding

1. **Which events?** All listed or subset?
2. **Which chain?** [Detected chain] or multi-chain?
3. **Time range?** Full history or recent blocks?
4. **Storage?** ClickHouse (recommended) or PostgreSQL?
```

## When to Stop Searching

**Stop after 2 failed attempts** if:
- Block explorer blocks access (403 error)
- Deployment block not found via web search
- Information not in official docs

**Instead**:
- Provide manual instructions for user
- Give them the URL to check themselves
- Offer conservative estimates

**Remember**: User's time is valuable - don't waste 10 minutes on repeated failed searches

## Integration with Other Skills

### After research approved:
- **ABI_GUIDE.md**: Fetch full ABI from block explorer and generate TypeScript types
- **SCHEMA_GUIDE.md**: Design ClickHouse schema for the indexed events
- **TEMPLATES.md**: Pick the right CLI template and generate the project
- **TROUBLESHOOTING.md**: Debug if issues arise

## Related Documentation

- See ABI_GUIDE.md for ABI fetching and proxy contract handling
- See SCHEMA_GUIDE.md for ClickHouse schema design patterns
- See ENVIRONMENT_SETUP.md for development prerequisites
