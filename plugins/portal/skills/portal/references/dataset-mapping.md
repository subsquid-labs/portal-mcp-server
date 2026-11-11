# Portal Dataset Names

Maps common chain names to Portal dataset slugs. The public catalog returned **106 entries on 2026-11-11**, 34 of them real-time; the SQD docs round coverage to "110+ networks", which includes private datasets such as Arc. Re-check with:

```bash
curl -sS https://portal.sqd.dev/datasets                    # public catalog: dataset, aliases, real_time
curl -sI https://portal.sqd.dev/datasets/{slug}/metadata    # 200 = served, 404 = retired or misspelled
```

Or via MCP: `portal_list_networks` (search by name, alias or chain ID; filter with `vm` and `real_time_only`).

A slug is usable when `/metadata` answers `200` and it is absent from [Retired datasets](#retired-datasets). Retirements are announced ahead of the cut-off at <https://docs.sqd.dev/announcements>, so a slug can still answer `200` while it has an end date.

## Real-Time Datasets (34)

These stream to the live chain head. Every other dataset serves finalized history only.

| Common Name | Portal Dataset Name | Type |
|-------------|-------------------|------|
| Ethereum | `ethereum-mainnet` | EVM |
| Ethereum Mainnet TB (catalog slug) | `ethereum-mainnet-tb` | EVM |
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
| Katana | `katana-mainnet` | EVM |
| MegaETH | `megaeth-mainnet` | EVM |
| Monad | `monad-mainnet` | EVM |
| Plasma | `plasma-mainnet` | EVM |
| Soneium | `soneium-mainnet` | EVM |
| TAC | `tac-mainnet` | EVM |
| Unichain | `unichain-mainnet` | EVM |
| Zora | `zora-mainnet` | EVM |
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
| Alpen Testnet | `alpen-testnet` | EVM (testnet) |

Substrate datasets are finalized-history only.

## Historical-Only EVM Mainnets

| Common Name | Portal Dataset Name |
|-------------|-------------------|
| Scroll | `scroll-mainnet` |
| Mantle | `mantle-mainnet` |
| Mode | `mode-mainnet` |
| Arbitrum Nova | `arbitrum-nova` |
| Sonic | `sonic-mainnet` |
| opBNB | `opbnb-mainnet` |
| Metis | `metis-mainnet` |
| Manta Pacific | `manta-pacific` |
| Astar (EVM) | `astar-mainnet` |
| Astar zkEVM | `astar-zkevm-mainnet` |
| Hedera (EVM mirror) | `hedera-mainnet` |
| Etherlink | `etherlink-mainnet` |
| Lukso | `lukso-mainnet` |
| Core | `core-mainnet` |
| X Layer | `xlayer-mainnet` |
| zkLink Nova | `zklink-nova-mainnet` |
| Plume | `plume-mainnet` |
| HashKey | `hashkey-mainnet` |
| Hemi | `hemi-mainnet` |
| BOB | `bob-mainnet` |
| B3 | `b3-mainnet` |
| Beam | `beam-mainnet` |
| Prom | `prom-mainnet` |
| Bittensor EVM | `bittensor-mainnet-evm` |
| Peaq (EVM) | `peaq-mainnet` |

Testnets for these chains are in the [catalog snapshot](#public-catalog-snapshot-2026-11-11-106-entries).

## Solana-VM (SVM) Datasets

| Common Name | Portal Dataset Name |
|-------------|-------------------|
| Solana | `solana-mainnet` (alias: `solana-beta`) |
| Solana Devnet | `solana-devnet` |
| SOON | `soon-mainnet` (+ `soon-devnet`, `soon-testnet`) |
| SVM BNB | `svm-bnb-mainnet` (+ `svm-bnb-testnet`) |

All take `"type": "solana"` queries.

## Substrate Datasets

| Common Name | Portal Dataset Name |
|-------------|-------------------|
| Polkadot | `polkadot` |
| Kusama | `kusama` |
| Polkadot Asset Hub | `asset-hub-polkadot` |
| Kusama Asset Hub | `asset-hub-kusama` |
| Paseo Asset Hub | `asset-hub-paseo` |
| Westend Asset Hub | `asset-hub-westend` |
| Astar (Substrate) | `astar-substrate` |
| Peaq (Substrate) | `peaq-mainnet-substrate` |
| Peaq Agung testnet (Substrate) | `agung` |
| Hydration (HydraDX) | `hydradx` |
| Vara | `vara` |
| Bittensor | `bittensor` (+ `bittensor-testnet`) |
| Chainflip | `chainflip` |
| zkVerify | `zkverify-mainnet` (+ `zkverify-testnet`) |

Four chains have both a Substrate dataset (`"type": "substrate"`) and an EVM dataset (`"type": "evm"`). Pick by the data model the question needs; the Frontier filters that read EVM activity from the Substrate side (`evmLogs`, `ethereumTransactions`) are in `substrate.md`.

| Chain | Substrate dataset | EVM dataset |
|---|---|---|
| Astar | `astar-substrate` | `astar-mainnet` |
| Peaq | `peaq-mainnet-substrate` | `peaq-mainnet` |
| Peaq Agung | `agung` | `agung-evm` |
| Bittensor | `bittensor` | `bittensor-mainnet-evm` |

## Hyperliquid Datasets

| Common Name | Portal Dataset Name | Type |
|-------------|-------------------|------|
| HyperEVM | `hyperliquid-mainnet` | EVM |
| HyperEVM Testnet | `hyperliquid-testnet` | EVM |
| Hyperliquid Fills | `hyperliquid-fills` | HyperliquidFills |
| Hyperliquid Replica Cmds | `hyperliquid-replica-cmds` | HyperliquidReplicaCmds |

## Names That Differ Across Platforms

| Blockchain | DeFiLlama | Portal | Explorer |
|-----------|-----------|--------|-----------|
| Arbitrum | arbitrum | `arbitrum-one` | arbiscan.io |
| BSC | bsc | `binance-mainnet` | bscscan.com |
| zkSync Era | zksync-era | `zksync-mainnet` | explorer.zksync.io |
| Tron | tron | `tron-mainnet` | tronscan.org |

## Retired Datasets

A retired slug answers `404` with `"code": "unknown_dataset"` and has no replacement dataset. Tell the user the dataset is retired and offer RPC or a private Portal; a similarly named live slug is a different network.

| Date | Retired |
|---|---|
| 2026-11-04 | `galxe-gravity` (Gravity Alpha shut down), `enjin-matrix`, `enjin-canary-matrix`, `enjin-relay` ([changelog](https://docs.sqd.dev/changelog)) |
| 2026-10-20 | `blast-l2-mainnet`, `abstract-mainnet`, `abstract-testnet` ([announcement](https://docs.sqd.dev/announcements/dataset-retirements-october-2026)) |
| 2026-09-23 | Legacy testnets: `blast-sepolia`, `celo-alfajores-testnet`, `gelato-opcelestia-raspberry`, `xlayer-testnet`, `x1-testnet` |
| 2026-09-22 | `moonbeam-mainnet`, `moonbeam-substrate`, `moonriver-mainnet`, `moonriver-substrate`, `polygon-zkevm-mainnet`, `taiko-mainnet` |
| 2026-08-20 | 67 low-usage datasets, listed below ([announcement](https://docs.sqd.dev/announcements/dataset-retirements-august-2026)) |
| 2026-08-05 | `ethereum-holesky` (use `ethereum-sepolia` or `ethereum-hoodi`) and thirty low-usage testnets and parachains such as `westend`, `rococo`, `dancebox` |
| July 2026 and earlier | `worldchain-mainnet`, `fantom-mainnet`, `adi-mainnet`, `adi-testnet`, `memecore-mainnet`, `exosama`, `botanix-mainnet` |

Also absent from the public catalog since the 2026-09-10 snapshot: `amplitude`, `eden`, `etherlink-testnet`, `invarch-parachain`, `invarch-tinkernet`, `moonbase-substrate`, `moonbase-testnet`, `polygon-zkevm-cardona-testnet`, `vara-testnet`, `zeitgeist`, `zeitgeist-testnet`.

Retired on 2026-08-20 at 12:00 UTC:

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

## Public Catalog Snapshot (2026-11-11, 106 entries)

Grep this block for a slug, then confirm it with `/metadata` before use. The live catalog is the source of truth; this copy saves a request when the name is already here.

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
megaeth-mainnet megaeth-testnet metis-mainnet mode-mainnet monad-mainnet monad-testnet
opbnb-mainnet opbnb-testnet optimism-mainnet optimism-sepolia peaq-mainnet peaq-mainnet-substrate
plasma-mainnet plasma-testnet plume-mainnet polkadot polygon-amoy-testnet polygon-mainnet
prom-mainnet scroll-mainnet scroll-sepolia solana-devnet solana-mainnet soneium-mainnet
soneium-minato-testnet sonic-mainnet sonic-testnet soon-devnet soon-mainnet soon-testnet
svm-bnb-mainnet svm-bnb-testnet tac-mainnet tron-mainnet unichain-mainnet unichain-sepolia vara
xlayer-mainnet zklink-nova-mainnet zksync-mainnet zksync-sepolia zkverify-mainnet zkverify-testnet
zora-mainnet zora-sepolia
```
