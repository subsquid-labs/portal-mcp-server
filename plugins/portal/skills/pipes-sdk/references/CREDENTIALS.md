# Credentials for indexers and database tools

Use only connections the user has authorized. Adding an MCP server, provisioning an account, or deploying an indexer requires authorization for that action.

The user supplies keys and passwords directly through their application's secret manager or private configuration. Never ask for them in chat, read them from existing files or environments, or copy them into commands, logs, reports, or version control. Inspect configuration names and redacted authentication results instead.

## Local ClickHouse

The runnable local examples use user `default` and password `default` on loopback for development. For another database, have the user configure the connection directly in their application. Replace demo passwords before shared or hosted use.

A `docker exec ... clickhouse-client` example assumes the container already has its client credentials configured. If that fails, have the user configure a protected ClickHouse client file rather than inspecting the container for a password. Verify with `SELECT 1` before mutations.

The user may keep private settings in an ignored `.env` file or a secret store. Document variable names with placeholders in `.env.example`, keep `.env` ignored, and leave the values for the user to supply. Do not load `.env` into the agent's shell.

## ClickHouse Cloud

Have the user configure their application or a protected ClickHouse client file with the confirmed Cloud hostname, database, user, and password. Use TLS and normal certificate validation. Ask for a redacted authentication result if the connection fails; do not ask for the password.

## Portal API key

The public Portal and its hosted MCP server need no key. An authenticated plan or dedicated Portal takes `Authorization: Bearer <key>` or `x-api-key: <key>`. The user creates and configures the key in their own secret store; the agent does not recover or transmit it.

Use `SQD_PORTAL_URL` and `SQD_PORTAL_API_KEY` as placeholder variable names when documenting a project. Have the user follow the [Portal setup guide](../../portal/references/setup.md) to configure and verify the key. An existing v2 gateway has a different setup; use the `migrate-to-portal` skill.

## MCP and hosted applications

Reuse an already configured connector. When the user requests a new one, have them configure it through their client's documented secret store or launch-time environment. Keep credentials out of `claude mcp add` arguments and shared project configuration.

For an authorized deployment, have the user populate the deployment platform's secret variables. Report the names configured and the verification result, without their values.

## References

- [ClickHouse client configuration](https://clickhouse.com/docs/interfaces/cli)
- [Dedicated Portal key](https://docs.sqd.dev/en/sdk/squid-sdk/evm/guides/migration/portal-api-key)
