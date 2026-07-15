# Full Portal Chain Name Mapping

Portal serves **234 datasets** (as of July 2026). This file maps common chain names to Portal dataset names. For the always-current list:

```bash
curl -s https://portal.sqd.dev/datasets          # full catalog with real_time flags
curl -I https://portal.sqd.dev/datasets/{name}/metadata   # 200 = exists, 404 = wrong name
```

Or via MCP: `portal_list_networks` (search by name/alias/chain ID, filter by `vm` and `real_time_only`).

## Real-Time Datasets (34)

These datasets stream to the live chain head; everything else is finalized-historical only.

| Common Name | Portal Dataset Name | Type |
|-------------|-------------------|------|
| Ethereum | `ethereum-mainnet` | EVM |
| Arbitrum | `arbitrum-one` | EVM |
| Base | `base-mainnet` | EVM |
| Optimism | `optimism-mainnet` | EVM |
| Polygon | `polygon-mainnet` | EVM |
| BSC / Binance | `binance-mainnet` | EVM |
| Avalanche C-Chain | `avalanche-mainnet` | EVM |
| zkSync Era | `zksync-mainnet` | EVM |
| Linea | `linea-mainnet` | EVM |
| Gnosis | `gnosis-mainnet` | EVM |
| Celo | `celo-mainnet` | EVM |
| Berachain | `berachain-mainnet` | EVM |
| Flare | `flare-mainnet` | EVM |
| Ink | `ink-mainnet` | EVM |
| MegaETH | `megaeth-mainnet` | EVM |
| Monad | `monad-mainnet` | EVM |
| Plasma | `plasma-mainnet` | EVM |
| Soneium | `soneium-mainnet` | EVM |
| TAC | `tac-mainnet` | EVM |
| Unichain | `unichain-mainnet` | EVM |
| Zora | `zora-mainnet` | EVM |
| ADI | `adi-mainnet` | EVM |
| HyperEVM | `hyperliquid-mainnet` | EVM |
| Hyperliquid Fills | `hyperliquid-fills` | HyperliquidFills |
| Solana | `solana-mainnet` (alias: `solana-beta`) | Solana |
| Solana Devnet | `solana-devnet` | Solana |
| Bitcoin | `bitcoin-mainnet` | Bitcoin |
| Tron | `tron-mainnet` | Tron |
| Ethereum Sepolia | `ethereum-sepolia` | EVM (testnet) |
| Arbitrum Sepolia | `arbitrum-sepolia` | EVM (testnet) |
| Polygon Amoy | `polygon-amoy-testnet` | EVM (testnet) |
| Monad Testnet | `monad-testnet` | EVM (testnet) |
| ADI Testnet | `adi-testnet` | EVM (testnet) |
| Alpen Testnet | `alpen-testnet` | EVM (testnet) |

> **Real-time streaming is NOT supported for Substrate chains** — those are finalized-historical only.

## Popular Historical-Only EVM Chains

| Common Name | Portal Dataset Name |
|-------------|-------------------|
| Scroll | `scroll-mainnet` |
| Blast | `blast-l2-mainnet` |
| Mantle | `mantle-mainnet` |
| Mode | `mode-mainnet` |
| Taiko | `taiko-mainnet` |
| Polygon zkEVM | `polygon-zkevm-mainnet` |
| Arbitrum Nova | `arbitrum-nova` |
| Sonic | `sonic-mainnet` |
| opBNB | `opbnb-mainnet` |
| Metis | `metis-mainnet` |
| Manta Pacific | `manta-pacific` |
| Moonbeam (EVM) | `moonbeam-mainnet` |
| Moonriver (EVM) | `moonriver-mainnet` |
| Astar (EVM) | `astar-mainnet` |
| Abstract | `abstract-mainnet` |
| Immutable zkEVM | `immutable-zkevm-mainnet` |
| Hedera (EVM mirror) | `hedera-mainnet` |
| Neon EVM | `neon-mainnet` |
| Etherlink | `etherlink-mainnet` |
| Lukso | `lukso-mainnet` |
| Core | `core-mainnet` |
| X Layer | `xlayer-mainnet` |
| zkLink Nova | `zklink-nova-mainnet` |
| Superseed | `superseed-mainnet` |
| Plume | `plume-mainnet` |
| Katana | `katana-mainnet` |
| Hemi | `hemi-mainnet` |
| Merlin | `merlin-mainnet` |
| BOB | `bob-mainnet` |
| Cyber | `cyber-mainnet` |
| Degen Chain | `degen-chain` |
| DFK Chain | `dfk-chain` |
| Dogechain | `dogechain-mainnet` |
| Canto | `canto` |
| Galxe Gravity | `galxe-gravity` |
| B3 | `b3-mainnet` |
| Beam | `beam-mainnet` |
| MemeCore | `memecore-mainnet` |
| Prom | `prom-mainnet` |
| SKALE Nebula | `skale-nebula` |
| Bittensor EVM | `bittensor-mainnet-evm` |
| Peaq (EVM) | `peaq-mainnet` |
| Shiden (EVM) | `shiden-mainnet` |
| Aleph Zero EVM | `aleph-zero-evm-mainnet` |

### Removed from Portal (do NOT use)

- ❌ `worldchain-mainnet` — no longer served
- ❌ `fantom-mainnet` — no longer served
- ❌ `acala-substrate` — use `acala`
- ❌ `subsocial` — use `subsocial-parachain`

## Solana-VM (SVM) Datasets

| Common Name | Portal Dataset Name | Type |
|-------------|-------------------|------|
| Solana | `solana-mainnet` (alias: `solana-beta`) | Solana |
| Solana Devnet | `solana-devnet` | Solana |
| SOON | `soon-mainnet` (+ `soon-devnet`, `soon-testnet`) | Solana |
| SVM BNB | `svm-bnb-mainnet` (+ `svm-bnb-testnet`) | Solana |

All use `"type": "solana"` queries.

## Substrate Chains (selection)

| Common Name | Portal Dataset Name |
|-------------|-------------------|
| Polkadot | `polkadot` |
| Kusama | `kusama` |
| Polkadot Asset Hub | `asset-hub-polkadot` |
| Kusama Asset Hub | `asset-hub-kusama` |
| Moonbeam (Substrate) | `moonbeam-substrate` |
| Moonriver (Substrate) | `moonriver-substrate` |
| Astar (Substrate) | `astar-substrate` |
| Acala | `acala` |
| Hydration (HydraDX) | `hydradx` |
| Bifrost | `bifrost-polkadot` / `bifrost-kusama` |
| Phala | `phala` |
| Interlay | `interlay` |
| Centrifuge | `centrifuge` |
| Vara | `vara` |
| Avail | `avail` |
| Bittensor | `bittensor` |
| Frequency | `frequency` |
| Polymesh | `polymesh` |
| Zeitgeist | `zeitgeist` |
| Subsocial | `subsocial-parachain` |
| Enjin Matrix | `enjin-matrix` |
| KILT | `kilt` |
| Peaq (Substrate) | `peaq-mainnet-substrate` |

Many more parachains are available — search the full list below or use `portal_list_networks` with `vm: "substrate"`.

> **Note:** Frontier EVM parachains (Moonbeam, Astar, Shiden, Peaq) have both EVM and Substrate datasets. Use the `-substrate` suffix with `"type": "substrate"` for Substrate queries; use the EVM dataset (e.g., `moonbeam-mainnet`) with `"type": "evm"` for EVM queries.

## Non-EVM Chains

| Common Name | Portal Dataset Name | Type |
|-------------|-------------------|------|
| Bitcoin | `bitcoin-mainnet` | Bitcoin |
| Tron | `tron-mainnet` | Tron |
| Solana | `solana-mainnet` | Solana |
| HyperEVM | `hyperliquid-mainnet` | EVM |
| HyperEVM Testnet | `hyperliquid-testnet` | EVM |
| Hyperliquid Fills | `hyperliquid-fills` | HyperliquidFills |
| Hyperliquid Replica Cmds | `hyperliquid-replica-cmds` | HyperliquidReplicaCmds |

## Platform Name Comparison

Different platforms use different names for the same chains:

| Blockchain | DeFiLlama | Portal | Etherscan |
|-----------|-----------|--------|-----------|
| Arbitrum | arbitrum | arbitrum-one | arbiscan.io |
| BSC | bsc | binance-mainnet | bscscan.com |
| zkSync Era | zksync-era | zksync-mainnet | explorer.zksync.io |
| Blast | blast | blast-l2-mainnet | blastscan.io |
| Tron | tron | tron-mainnet | tronscan.org |

**Always use Portal-specific names when querying the Portal API.**

## Complete Dataset List (July 2026, 234 datasets)

Grep this block to check a name; verify with the `/metadata` endpoint before use.

```
0g-testnet abstract-mainnet abstract-testnet acala acurast-canary adi-mainnet adi-testnet agung agung-evm
aleph-zero aleph-zero-evm-mainnet aleph-zero-testnet alpen-testnet amplitude arbitrum-nova arbitrum-one
arbitrum-sepolia arthera-mainnet asset-hub-kusama asset-hub-paseo asset-hub-polkadot asset-hub-rococo
asset-hub-westend astar-mainnet astar-substrate astar-zkevm-mainnet astar-zkyoto avail avalanche-mainnet
avalanche-testnet b3-mainnet b3-sepolia base-mainnet base-sepolia basilisk beam-mainnet berachain-bartio
berachain-mainnet bifrost-kusama bifrost-polkadot binance-mainnet binance-testnet bitcoin-mainnet
bitfinity-mainnet bitfinity-testnet bitgert-mainnet bitgert-testnet bittensor bittensor-mainnet-evm
bittensor-testnet bittensor-testnet-evm blast-l2-mainnet blast-sepolia bob-mainnet bob-sepolia
bridge-hub-kusama bridge-hub-polkadot bridge-hub-rococo bridge-hub-westend camp-network-testnet-v2 canto
canto-testnet celo-alfajores-testnet celo-mainnet centrifuge cere chainflip clover collectives-polkadot
collectives-westend core-mainnet crust cyber-mainnet cyberconnect-l2-testnet dancebox darwinia
darwinia-crab data-avail degen-chain dfk-chain dogechain-mainnet dogechain-testnet eden
enjin-canary-matrix enjin-matrix enjin-relay equilibrium ethereum-holesky ethereum-hoodi ethereum-mainnet
ethereum-sepolia etherlink-mainnet etherlink-shadownet etherlink-testnet exosama flare-mainnet
formicarium-testnet foucoco frequency galxe-gravity gelato-arbitrum-blueberry gelato-opcelestia-raspberry
gemini-3h gnosis-mainnet hedera-mainnet hemi-mainnet hemi-testnet hydradx hyperliquid-fills
hyperliquid-mainnet hyperliquid-replica-cmds hyperliquid-testnet immutable-zkevm-mainnet
immutable-zkevm-testnet ink-mainnet ink-sepolia integritee interlay invarch-parachain invarch-tinkernet
joystream karura katana-mainnet khala kilt kintsugi kusama kyoto-testnet linea-mainnet litentry
lukso-mainnet manta-pacific manta-pacific-sepolia mantle-mainnet mantle-sepolia megaeth-mainnet
megaeth-testnet memecore-insectarium memecore-mainnet merlin-mainnet merlin-testnet metis-mainnet
mode-mainnet monad-mainnet monad-testnet moonbase-substrate moonbase-testnet moonbeam-mainnet
moonbeam-substrate moonriver-mainnet moonriver-substrate moonsama nakachain neon-devnet neon-mainnet
neox-testnet opbnb-mainnet opbnb-testnet optimism-mainnet optimism-sepolia ozean-testnet paseo
peaq-mainnet peaq-mainnet-substrate pendulum people-chain phala phala-testnet picasso plasma-mainnet
plasma-testnet plume-mainnet plume-testnet polimec polkadex polkadot polygon-amoy-testnet polygon-mainnet
polygon-zkevm-cardona-testnet polygon-zkevm-mainnet polymesh prom-mainnet reef reef-testnet robonomics
rococo rolimec scroll-mainnet scroll-sepolia shibuya-substrate shibuya-testnet shiden-mainnet
shiden-substrate skale-nebula solana-devnet solana-mainnet soneium-mainnet soneium-minato-testnet
sonic-mainnet sonic-testnet soon-devnet soon-mainnet soon-testnet sora-mainnet stratovm-sepolia
subsocial-parachain superseed-mainnet superseed-sepolia svm-bnb-mainnet svm-bnb-testnet tac-mainnet
taiko-mainnet tanssi ternoa tron-mainnet turing-avail turing-mainnet unichain-mainnet unichain-sepolia
vara vara-testnet westend x1-testnet xlayer-mainnet xlayer-testnet zeitgeist zeitgeist-testnet
zklink-nova-mainnet zksync-mainnet zksync-sepolia zkverify-mainnet zkverify-testnet zora-mainnet
zora-sepolia
```

## Quick Reference: Top Chains

```json
{
  "Ethereum": "ethereum-mainnet",
  "Arbitrum": "arbitrum-one",
  "Base": "base-mainnet",
  "Optimism": "optimism-mainnet",
  "Polygon": "polygon-mainnet",
  "BSC": "binance-mainnet",
  "Avalanche": "avalanche-mainnet",
  "zkSync Era": "zksync-mainnet",
  "Linea": "linea-mainnet",
  "Gnosis": "gnosis-mainnet",
  "Celo": "celo-mainnet",
  "Berachain": "berachain-mainnet",
  "Monad": "monad-mainnet",
  "MegaETH": "megaeth-mainnet",
  "Unichain": "unichain-mainnet",
  "Scroll": "scroll-mainnet",
  "Blast": "blast-l2-mainnet",
  "Polkadot": "polkadot",
  "Kusama": "kusama",
  "Moonbeam (Substrate)": "moonbeam-substrate",
  "Solana": "solana-mainnet",
  "Bitcoin": "bitcoin-mainnet",
  "Tron": "tron-mainnet",
  "Hyperliquid Fills": "hyperliquid-fills",
  "HyperEVM": "hyperliquid-mainnet"
}
```

## Using Dataset Names as Constants

```typescript
const PORTAL_DATASETS = {
  ETHEREUM: 'ethereum-mainnet',
  ARBITRUM: 'arbitrum-one',
  BASE: 'base-mainnet',
  OPTIMISM: 'optimism-mainnet',
  BSC: 'binance-mainnet',
  SOLANA: 'solana-mainnet',
  BITCOIN: 'bitcoin-mainnet',
  TRON: 'tron-mainnet'
} as const;

// Use:
const url = `https://portal.sqd.dev/datasets/${PORTAL_DATASETS.ARBITRUM}/stream`;
```
