# Temporary EVM v2 Gateway Authentication

As of the May 19, 2026 12:00 UTC cutover, authenticated calls to the v2 gateway are mandatory for self-hosted setups. Migrating to Portal is the recommended path. The public Portal is shared capacity; authenticated and dedicated Portal endpoints accept `x-api-key` with the same paths and payloads.

Use this intermediate configuration only when the user explicitly wants to remain on an EVM v2 gateway that still exists. Eighteen datasets became Portal-only on 2026-08-05, 67 more retired from both v2 and Portal on 2026-08-20, and the remaining gateways are being sunset.

## Configure the key

The key belongs to the user. Don't ask for it, read it from the user's environment or files, or write it into the project.

1. The user registers at <https://portal.sqd.dev/app> and creates a gateway API key.
2. Upgrade `@subsquid/evm-processor` to `1.30.0` or later on the v2 line:

```bash
npm i @subsquid/evm-processor@^1.30.0
```

3. The user adds the key to the squid as SQD's gateway API key guide describes: <https://docs.sqd.dev/changelog/gateway-api-keys>.

Older processor versions reject the gateway `apiKey` setting with `TS2353: 'apiKey' does not exist in type 'GatewaySettings'`.

Going to `latest` instead skips this intermediate configuration: the current EVM stack uses `@subsquid/evm-stream` / `@subsquid/evm-objects`, where `setGateway` is gone. Pin the v2 version only when remaining on v2 is deliberate.

References:

- <https://docs.sqd.dev/changelog/gateway-api-keys>
- <https://docs.sqd.dev/en/data/api-keys>
