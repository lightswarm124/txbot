# AGENTS.md — experiment reports

Reports are the durable record of each bot iteration and must be safe to share
with the research owner.

## Required content

Each iteration entry in `CODEX_REPORT.md` must identify:

- iteration number/date and hypothesis;
- code and fixture changes;
- mode, worker count, input cap, swap size, backend, and network;
- commands actually run and their results;
- measured metrics, including first-broadcast success, retries, give-ups,
  conflicts, insufficient idle liquidity, latency, contention, and unique
  pools;
- UTXO-boundary findings, exact non-sensitive node/indexer errors, bottleneck
  assessment, and one next question.

Fee evidence must include final serialized byte size and fee satoshis. The
expected relationship is exactly `fee_sats == size_bytes` for the experiment's
1 sat/byte policy; an unsigned or placeholder size is not sufficient evidence.

Use `blocked` with a concrete reason when a required API, schema, backend, or
authorized network is unavailable. Do not invent chain data or fill missing
metrics with estimates.

## Redaction rules

Never include mnemonics, private keys, signatures, raw signed transactions,
wallet files, credentials, secret environment values, or seed-derived address
lists. Outpoints, txids, addresses, and backend URLs should be recorded only
when they are sanitized test fixtures or explicitly approved public Chipnet
data. Prefer aggregate counts and stable fixture identifiers.

Local `.env` files may provide runtime secrets, but reports must never quote
their values, dump their contents, or record derived wallet material.

Raw errors may be copied verbatim only after checking that they contain no
secret-bearing request data. Reports must not become a second wallet log.

## Evidence discipline

Label statements as measured, inferred, or unresolved. Include timestamps and
fixture/backend identifiers where useful. Preserve failed runs and explain
whether a failure is a product behavior, harness issue, or environmental
blocker. A report is not complete until the changed-file diff and redaction
review have been performed.
