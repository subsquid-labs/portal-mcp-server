# Pipes compatibility as of 2026-11-10

Use this before upgrading an indexer or copying an older SDK example. These notes were checked against the published `@subsquid/pipes@1.0.0-beta.11` and `@subsquid/pipes-cli@1.0.0-beta.3` package sources and the release notes linked below. They do not prove an existing indexer's upgrade works; run its own validation over a fixed range.

## Resolve versions before installing

The SDK's npm `latest` tag is beta.11, while its `beta` tag is still beta.4. CLI `latest` is beta.3, while `beta` is beta.2. Use an exact reviewed version and commit the lockfile. Check `npm view @subsquid/pipes dist-tags --json` and `npm view @subsquid/pipes-cli dist-tags --json` before updating an old project.

The BigQuery reference is explicitly a beta.6 source audit. Keep that pin when following its version-specific contract, or compare the selected release's source before upgrading it.

## Pub/Sub changed in beta.5

`signals` routes were removed. The target emits CDC rows with finality in each message's `_finalized` attribute. Consume the maximum finality watermark; it is not a message-arrival or completeness signal.

A fresh empty state is refused by default. Set `allowColdStart: true` only to bootstrap a namespace that has never published. Lost state for an existing feed requires a fresh namespace and consumer re-bootstrap; allowing a cold start on the old namespace can make BigQuery discard lower sequence numbers. State before schema 4 also needs a fresh namespace and state path.

The default `sequenceBarrier: true` requires one topic per producer and ordered block operations. Merge multiple outputs into one route, or use `sequenceBarrier: false` only after confirming that no consumer relies on the gap-free sequence. Preserve the state file on durable storage and run one producer per path.

Beta.11 moves finalized-state cleanup into chunks between batches and resumes cleanup after restart. Before downgrading, follow its release note's check that cleanup has finished.

Sources: [beta.5 migration](https://github.com/subsquid/pipes-sdk/releases/tag/pipes-v1.0.0-beta.5), [beta.11 cleanup and downgrade](https://github.com/subsquid/pipes-sdk/releases/tag/pipes-v1.0.0-beta.11).

## RPC latency watchers changed in beta.6

Watchers emit `LatencySample[]`, so iterate every returned sample. `portalDelayMs` is signed; a negative value means Portal arrived first. `unresolved: "rpc-behind"` or `"rpc-missing"` means the delay is absent, not zero. Count unresolved observations separately. The watcher accepts `resolveTimeoutMs`, and beta.7 exports `LatencySample` and `RpcObservation` from the chain modules.

Sources: [beta.6 latency semantics](https://github.com/subsquid/pipes-sdk/releases/tag/pipes-v1.0.0-beta.6), [beta.7 exports](https://github.com/subsquid/pipes-sdk/releases/tag/pipes-v1.0.0-beta.7).

## Portal overload and EVM field compatibility

Beta.7 retries Portal HTTP `529` capacity errors. Honor `Retry-After` instead of treating overload as an invalid query. The release also adds optional Avalanche header columns; check field availability for the selected dataset.

Beta.8 accepts blob gas quantities as hexadecimal or decimal strings. EVM transaction `effectiveGasPrice` and `type` can be absent after decoding Portal `null` values. Handle missing values explicitly rather than substituting zero or declaring an unsupported transaction invalid.

Sources: [beta.7 overload handling](https://github.com/subsquid/pipes-sdk/releases/tag/pipes-v1.0.0-beta.7), [beta.8 EVM compatibility](https://github.com/subsquid/pipes-sdk/releases/tag/pipes-v1.0.0-beta.8).
