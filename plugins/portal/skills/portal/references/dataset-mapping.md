# Portal dataset names

Dataset availability changes. Discover networks with `portal_list_networks` or `GET https://portal.sqd.dev/datasets`, then inspect `portal_get_network_info` for available tables, indexed coverage, and freshness. A dataset name alone does not prove ingestion is current.

The public catalog contained 106 datasets on 2026-11-10. The tables and snapshot below record that response; use live discovery before choosing a dataset.

## Common names

| Common name | Dataset | Type |
|---|---|---|
| Ethereum | `ethereum-mainnet` | evm |
| Arbitrum | `arbitrum-one` | evm |
| Base | `base-mainnet` | evm |
| Optimism | `optimism-mainnet` | evm |
| Polygon | `polygon-mainnet` | evm |
| BSC / Binance | `binance-mainnet` | evm |
| Avalanche C-Chain | `avalanche-mainnet` | evm |
| zkSync Era | `zksync-mainnet` | evm |
| Scroll | `scroll-mainnet` | evm |
| Linea | `linea-mainnet` | evm |
| Gnosis | `gnosis-mainnet` | evm |
| Polkadot | `polkadot` | substrate |
| Kusama | `kusama` | substrate |
| Solana | `solana-mainnet` | solana |
| Bitcoin | `bitcoin-mainnet` | bitcoin |
| Tron | `tron-mainnet` | tron |
| Hyperliquid fills | `hyperliquid-fills` | hyperliquidFills |
| HyperEVM | `hyperliquid-mainnet` | evm |
| Monad | `monad-mainnet` | evm |
| MegaETH | `megaeth-mainnet` | evm |
| Plasma | `plasma-mainnet` | evm |
| Unichain | `unichain-mainnet` | evm |

Frontier chains can have separate EVM and Substrate datasets. For example, `moonbeam-mainnet` is EVM and `moonbeam-substrate` is Substrate. Use the dataset type returned by metadata.

## Real-time snapshot

These 34 datasets reported `real_time: true` on 2026-11-10. This flag describes streaming support; compare the indexed head timestamp with wall time before calling data fresh.

```
alpen-testnet arbitrum-one arbitrum-sepolia avalanche-mainnet base-mainnet berachain-mainnet
binance-mainnet bitcoin-mainnet celo-mainnet ethereum-mainnet ethereum-mainnet-tb ethereum-sepolia
flare-mainnet gnosis-mainnet hyperliquid-fills hyperliquid-mainnet ink-mainnet katana-mainnet
linea-mainnet megaeth-mainnet monad-mainnet monad-testnet optimism-mainnet plasma-mainnet
polygon-amoy-testnet polygon-mainnet solana-devnet solana-mainnet soneium-mainnet tac-mainnet
tron-mainnet unichain-mainnet zksync-mainnet zora-mainnet
```

Substrate datasets provide finalized historical data. Query live metadata rather than assuming the real-time snapshot still holds.

## Retired on 2026-08-20

These 67 datasets retired on **2026-08-20 at 12:00 UTC** ([announcement](https://docs.sqd.dev/announcements/dataset-retirements-august-2026)). Ingestion stopped and access ended. Check this list before using a catalog result.

```
0g-testnet acala aleph-zero aleph-zero-evm-mainnet arthera-mainnet avail basilisk berachain-bartio
bifrost-kusama bifrost-polkadot bitfinity-mainnet bitgert-mainnet bridge-hub-kusama bridge-hub-polkadot canto
centrifuge cere clover collectives-polkadot crust cyber-mainnet darwinia darwinia-crab degen-chain dfk-chain
dogechain-mainnet equilibrium frequency gelato-arbitrum-blueberry immutable-zkevm-mainnet integritee interlay
joystream karura khala kilt kintsugi litentry merlin-mainnet moonsama nakachain neon-devnet neon-mainnet
ozean-testnet paseo pendulum people-chain phala picasso plume-devnet polkadex polymesh poseidon-testnet reef reef-testnet robonomics
shibuya-substrate shiden-mainnet shiden-substrate skale-nebula sora-mainnet subsocial-parachain
superseed-mainnet tanssi ternoa turing-avail turing-mainnet
```

## Other retired networks

`galxe-gravity` was removed from the maintained SQD mapping before its 2026-11-01 shutdown. It is absent from this snapshot. See the [upstream retirement change](https://github.com/subsquid-labs/skills/commit/45e882d7b097).

An absent slug is unavailable on this public Portal. Do not substitute another mainnet or a similarly named testnet. If a private plan has different availability, use its authorized catalog.

## Public catalog snapshot, 2026-11-10

This is discovery data, not an availability commitment. Aliases are returned by the live catalog and are not counted as separate datasets.

```
agung agung-evm alpen-testnet arbitrum-nova arbitrum-one arbitrum-sepolia asset-hub-kusama
asset-hub-paseo asset-hub-polkadot asset-hub-westend astar-mainnet astar-substrate
astar-zkevm-mainnet astar-zkyoto avalanche-mainnet avalanche-testnet b3-mainnet b3-sepolia
base-mainnet base-sepolia beam-mainnet berachain-mainnet binance-mainnet binance-testnet
bitcoin-mainnet bittensor bittensor-mainnet-evm bittensor-testnet bittensor-testnet-evm bob-mainnet
bob-sepolia celo-mainnet chainflip core-mainnet ethereum-hoodi ethereum-mainnet ethereum-mainnet-tb
ethereum-sepolia etherlink-mainnet etherlink-shadownet flare-mainnet gnosis-mainnet hashkey-mainnet
hedera-mainnet hemi-mainnet hemi-testnet hydradx hyperliquid-fills hyperliquid-mainnet
hyperliquid-replica-cmds hyperliquid-testnet ink-mainnet ink-sepolia katana-mainnet kusama
linea-mainnet lukso-mainnet manta-pacific manta-pacific-sepolia mantle-mainnet mantle-sepolia
megaeth-mainnet megaeth-testnet metis-mainnet mode-mainnet monad-mainnet monad-testnet opbnb-mainnet
opbnb-testnet optimism-mainnet optimism-sepolia peaq-mainnet peaq-mainnet-substrate plasma-mainnet
plasma-testnet plume-mainnet polkadot polygon-amoy-testnet polygon-mainnet prom-mainnet
scroll-mainnet scroll-sepolia solana-devnet solana-mainnet soneium-mainnet soneium-minato-testnet
sonic-mainnet sonic-testnet soon-devnet soon-mainnet soon-testnet svm-bnb-mainnet svm-bnb-testnet
tac-mainnet tron-mainnet unichain-mainnet unichain-sepolia vara xlayer-mainnet zklink-nova-mainnet
zksync-mainnet zksync-sepolia zkverify-mainnet zkverify-testnet zora-mainnet zora-sepolia
```
