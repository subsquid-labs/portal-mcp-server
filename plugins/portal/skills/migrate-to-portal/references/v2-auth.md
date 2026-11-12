# Temporary EVM v2 Gateway Authentication

As of the May 19, 2026 12:00 UTC cutover, authenticated calls to the v2 gateway are mandatory for self-hosted setups. Migrating to Portal is the recommended path. The public Portal is shared capacity; authenticated and dedicated Portal endpoints accept `x-api-key` with the same paths and payloads.

Use this intermediate configuration only when the user explicitly wants to remain on an EVM v2 gateway that still exists. Eighteen datasets became Portal-only on 2026-08-05 (among them `astar-mainnet`, `berachain-mainnet`, `celo-mainnet`, `linea-mainnet`, `scroll-mainnet`, `unichain-mainnet`, `zksync-mainnet` and `zora-mainnet`), so a squid on one of those migrates. Every dataset retired since (67 on 2026-08-20, then Moonbeam, Moonriver, Polygon zkEVM, Taiko, Blast, Abstract and Enjin through November 2026) left the v2 gateways as well. The remaining gateways are being sunset.

## Configure the key

The key belongs to the user. Don't ask for it, read it from the user's environment or files, or write it into the project.

1. The user registers at <https://portal.sqd.dev/app> and creates a gateway API key.
2. Upgrade `@subsquid/evm-processor` to `1.30.0` or later on the v2 line (`1.30.2` on 2026-11-11, which also fixes RPC ingestion on Avalanche C-Chain after the Helicon upgrade):

```bash
npm i @subsquid/evm-processor@^1.30.0
```

3. The user adds the key to the squid as SQD's gateway API key guide describes: <https://docs.sqd.dev/en/sdk/squid-sdk/evm/guides/migration/gateway-api-key>.

Older processor versions reject the gateway `apiKey` setting with `TS2353: 'apiKey' does not exist in type 'GatewaySettings'`.

Migrating instead skips this intermediate configuration: the current EVM stack is `@subsquid/evm-stream` / `@subsquid/evm-objects`, which has no `setGateway`. Pin the v2 version only when remaining on v2 is deliberate.

References:

- <https://docs.sqd.dev/announcements/gateway-api-keys>
- <https://docs.sqd.dev/en/sdk/squid-sdk/evm/guides/migration/gateway-api-key>
