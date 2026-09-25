# Codex report — Cauldron contention bot

## Iteration 1 — Chipnet endpoint and fee-policy setup

### Hypothesis

The bot can use an ordered set of public Chipnet Electrum endpoints and fail
over between them without changing network selection. Transaction fees can be
enforced at exactly 1 sat/byte using final serialized size.

## Repo map

- libauth: `/home/lightswarm/projects/libauth`
- CashScript reference: `/home/lightswarm/projects/cashscript`
- wallet Chipnet test helper: `/home/lightswarm/projects/OPTNWallet/test-support/chipnetElectrum.ts`
- bot root: `/home/lightswarm/projects/txbot`

## What shipped

- modes working: none yet; bot remains scaffolded
- network: chipnet configuration only
- mocks used: no
- fee policy: exact 1 sat/byte requirement documented
- wallet transaction: not attempted; no signing or broadcast performed

## Endpoint availability

Read-only `blockchain.headers.subscribe` probes completed successfully:

| name | transport | result |
|---|---|---|
| bch-ninja | TLS :50002 | headers received |
| imaginary-cash | TLS :50002 | headers received |
| optnlabs | WSS :50004 | headers received |

## Fee-size tooling

CashScript provides `TransactionBuilder.getTransactionSize()` and
`calculateTransactionFee()`. The final transaction must be serialized after
actual unlockers/signatures are present; fee evidence must satisfy
`fee_sats == serialized_size_bytes`.

## Status at iteration 1

At the end of this iteration, the wallet-account transaction test had not been
executed. The wallet verification and live Chipnet data-fetch commands were
subsequently authorized and run in later iterations.

## Next ask for Grok

What is the smallest sanitized Cauldron-compatible mock UTXO fixture needed to
exercise the wallet builder without private wallet material or broadcasting?

## Iteration 2 — Automated PUSD purchase and three-pool setup script

### Hypothesis

CashLab can construct and verify the PUSD purchase and pool outputs locally,
while Electrum provides Chipnet UTXOs and broadcast. A plan-only default plus a
fixed spend budget can make the path inspectable before execution.

### Changes

- Added `src/cauldronSetup.ts` and `npm run cauldron:setup`.
- The plan-only path loads Riften's active PUSD pools and a sanitized wallet
  balance snapshot, then obtains a CashLab quote without constructing,
  signing, or broadcasting a transaction.
- Explicit `--execute` mode constructs a PUSD purchase and three P2SH pool
  outputs. It verifies PUSD category and wallet payout, pool script/category/
  reserves, CashLab transaction validity, and 1 sat/byte final serialized
  fees before each broadcast.
- Limits: 3 pools; up to 30,000,000 sats for the purchase; 10,000,000 sats BCH
  reserve per pool; 60,000,000 sats total configured BCH commitment before
  fees. Network: Chipnet. Backend: Riften indexer plus configured Electrum
  endpoints. Workers: 1 sequential transaction flow.
- If a PUSD balance already exists, automatic purchase is refused to avoid a
  duplicate buy; pool-only recovery is not yet implemented.

### Validation evidence

- `npm run cauldron:setup`: live plan-only quote succeeded; four active pools,
  proposed three new pools, quoted purchase supply 29,998,964 sats and 9,403
  PUSD atomic units. No transaction was signed or broadcast in this iteration.
- Wallet preflight: 500,000,000 native sats, one UTXO, zero token UTXOs at the
  configured receive path (aggregate output only).
- `npm run typecheck`: passed.
- `npm test`: passed, 4 tests across 2 files.
- `git diff --check`: passed.
- Signed transaction size/fee: not applicable; no signed transaction built.
- First-broadcast success, retries, give-ups, conflicts, insufficient idle
  liquidity, latency, contention, unique-pool count, and UTXO-boundary metrics:
  not measured; execution mode was not run.

### Remaining risk and next question

The `--execute` path is implemented but has not been exercised against live
transactions. If the buy is accepted but pool creation fails, the script
intentionally refuses a second automatic purchase; a separately validated
pool-only recovery path is needed. A repeated live plan attempt later failed
with a generic network `fetch failed`; the earlier successful plan is the only
quote evidence. Next: validate an isolated purchase transaction end-to-end on
Chipnet, then add bounded contention tests.

## Iteration 4 — Bounded high-frequency harness readiness

### Hypothesis

A bounded Cauldron runner can prepare sequential and intentional-contention
PUSD buys from live Chipnet state, using Electrum as the UTXO authority while
Riften's indexer catches up, without signing or broadcasting during readiness
checks.

### Changes

- Added `src/cauldronRuntime.ts` for wallet-derived runtime state, live
  Electrum UTXOs, Riften/indexer pool reconciliation, and sanitized broadcast
  outcomes.
- Added `src/cauldronHf.ts` and `npm run cauldron:hf` with plan, prepare, and
  explicit execute actions.
- Sequential mode advances pool successors and native BCH change in memory;
  contention mode builds distinct same-snapshot candidates so conflicts can be
  measured.
- Safety bounds: at most 100 iterations, 8 workers, 100,000 sats per order,
  and an explicit maximum attempted input cap. The default remains plan-only.
- Added sanitized fee evidence to runner output and clarified that the wallet
  verifier's 500,000,000-satoshi value is a pre-setup baseline.

### Measured readiness evidence

- Date: 2026-09-25. Network: Chipnet. Backend: Riften
  `indexer-chipnet.riften.net/cauldron` plus the configured Electrum
  fallbacks. Token: PUSD fixture configured in the bot.
- `npm run cauldron:hf`: passed. It found 7 live pools: 4 indexed and 3
  wallet-owned/confirmed through Electrum. Native wallet balance available to
  the runner was 439,998,914 sats. The default 10-iteration sequential plan
  requires 100,000 sats and remains under its 1,000,000-sat cap.
- Sequential preparation command with 2 iterations and 10,000-sat orders:
  passed; 2 signed candidates, 0 broadcasts, 1 unique pool touched,
  build-latency average 326 ms. Final serialized size was 445 bytes and fee
  was 445 sats for both samples; exact 1 sat/byte was true.
- Contention preparation command with 1 iteration and 4 workers:
  passed; 4 signed candidates, 0 broadcasts, 1 unique pool touched,
  build-latency average 329 ms. Final serialized size was 458 bytes and fee
  was 458 sats for all samples; exact 1 sat/byte was true.
- `npm run cauldron:verify-pools`: passed the Electrum readiness condition:
  3 unspent wallet-owned pool outputs totaling 30,000,000 sats. Riften still
  reports zero matching owner pools, so indexer visibility remains pending.
- `npm run typecheck`: passed. `npm test`: passed, 4 tests across 2 files.
  `git diff --check`: passed. A source/report redaction review found no
  mnemonic, private key, raw transaction, or secret value in the changed
  output.

### Unresolved execution metrics and risks

No live high-frequency execution was run in this readiness iteration, so
first-broadcast success, retries, give-ups, conflicts, accepted/rejected
counts, and broadcast latency remain unmeasured. The harness is ready to run,
but the first execute run should be a small sequential batch because each
successive transaction depends on the prior transaction's mempool-visible
change and pool successors. Contention mode intentionally reuses a snapshot
and is expected to produce conflicts; it should be run separately. The next
question is whether the configured Electrum backends propagate chained
transactions quickly enough for the desired frequency.

## Iteration 3 — Execute PUSD purchase and three pool outputs

### Hypothesis and correction

The first automated purchase attempt was rejected with Electrum RPC 1,
`Missing inputs`. The initial suspicion that indexed pools were stale was
incorrect: Electrum confirmed their outpoints were unspent. Root cause was
byte order: the builder reversed UI-order transaction IDs before passing them
to libauth, which itself reverses them during transaction serialization.

### Changes and execution

- Updated wallet and pool outpoints to pass Electrum/indexer transaction IDs in
  UI order; added live pool UTXO checks matching indexed BCH and PUSD reserves.
- Improved sanitized Electrum rejection reporting; no raw transactions or
  wallet identifiers are logged.
- Network: Chipnet; backend: Riften indexer and Electrum; mode: sequential
  execution, one worker; input cap: 60,000,000 sats principal before fees;
  purchase supply: 29,998,964 sats; pool count: 3; pool BCH reserve:
  10,000,000 sats each.
- The retry accepted both the PUSD purchase and pool transaction. Purchase
  size/fee: 833 bytes / 833 sats. Pool transaction size/fee: 638 bytes /
  638 sats. Both satisfy exactly 1 sat/byte.
- Unique pool outputs: 3. No high-frequency tests ran in this iteration.
- Post-broadcast wallet snapshot: 439,999,565 sats, two UTXOs, one
  PUSD-bearing UTXO. It initially showed one unconfirmed history entry.
- Later status: zero unconfirmed wallet-history entries; Electrum reported
  three unspent PUSD pool outputs totaling 30,000,000 sats, with all three
  outputs confirmed. Riften still returned zero owner-matching pools and four
  total active pools. Chain outputs are confirmed; indexer ingestion/visibility
  is still unresolved.

### Broadcast metrics and remaining risk

- First attempt: purchase rejected by all three Electrum endpoints with
  `Missing inputs`; wallet snapshot afterward was unchanged and showed no
  unconfirmed history.
- Retry: both transactions received matching transaction-ID acceptance
  responses from the Electrum broadcast flow. Per-endpoint retry counts and
  first-endpoint success are not emitted by this script and remain unresolved.
- Conflicts, give-ups after acceptance, insufficient idle liquidity, latency,
  and pool contention: not measured (no high-frequency run).
- UTXO boundary: each transaction was constructed from freshly listed wallet
  UTXOs; the pool spend used the three verified indexed pool inputs for the
  purchase and PUSD/BCH wallet outputs for pool creation.
- Bottleneck: indexer propagation/confirmation after Electrum acceptance.
- Next: verify all three pools appear in Riften, then use bounded Chipnet
  contention tests; preserve this run's failure and acceptance evidence.

## Iteration 5 — First live contention batch

### Hypothesis

Four distinct transactions built from one wallet/pool snapshot should exercise
same-input contention. At most one should become the effective pool state
transition; endpoint acknowledgements must not be mistaken for four durable
chain successes.

### Command and measured result

Command:

```text
npm run cauldron:hf -- --execute --mode=contention --iterations=1 --workers=4 --order-sats=10000 --max-input-sats=1000000
```

Network: Chipnet. Backend: configured Electrum fallbacks plus the Riften
indexer. The runner built 4 candidates from one snapshot and touched 1 pool.
Final candidate size/fee was 458 bytes / 458 sats for all 4 candidates, passing
the exact 1 sat/byte policy.

The runner measured 3 endpoint-acknowledged broadcasts, 1 rejected candidate,
5 retries, 1 first-endpoint success, 1 give-up, and 1 explicit mempool
conflict. Because the batch produced more than one endpoint acknowledgement,
the runner stopped without advancing its in-memory state.

### Post-run chain-state evidence

- `npm run cauldron:verify-pools`: Electrum showed 3 unspent wallet-owned pool
  outputs totaling 30,009,610 sats; Riften showed 1 matching owner pool
  totaling 10,009,610 sats. This is consistent with one observed pool
  successor and indexer lag, not three durable pool transitions.
- `npm run verify:wallet`: observed 439,989,497 native sats, 3 UTXOs, 2 token
  UTXOs, and 1 unconfirmed history entry. It exited nonzero because its
  500,000,000-satoshi value is the original pre-setup baseline.
- Inference: the three `accepted` values are endpoint-level broadcast
  acknowledgements from a propagation race. They are not confirmation that
  three conflicting transactions survived the network. No raw transactions,
  signatures, wallet identifiers, or secret material were recorded.

### Assessment and next question

The contention test successfully produced the intended conflict signal and
the harness failed closed instead of chaining from an ambiguous winner. Do not
start another spend batch until the current unconfirmed state settles. The
next implementation improvement is to expose endpoint acknowledgement and
network-observed/settled status as separate metrics, then run a small
sequential batch after the pending transaction is resolved.

## Iteration 6 — 1,000-transaction unconfirmed-chain preparation

### Hypothesis

The runner can construct a 1,000-transaction BCH-to-PUSD sequence while
tracking unconfirmed native change and Cauldron pool successors as local UTXOs,
without reusing a spent outpoint or repeatedly preparing the same transaction.

### Changes

- Raised the bounded preparation/execution ceiling to 1,000 iterations.
- Added a local UTXO ledger that tracks active native and pool outpoints,
  unconfirmed transaction origin/dependency depth, and consumed outpoints.
- Candidate inputs are resolved against the ledger in both transaction-hash
  byte orders, then rejected if stale, duplicated, overlapping, or unavailable.
- Sequential preparation advances the ledger after every candidate, so each
  candidate spends the prior unconfirmed BCH change and pool successor.
- Broadcasts are pinned to one Electrum endpoint and require the accepted
  transaction to be visible through `blockchain.transaction.get` before a
  child is allowed. Visibility failures stop the run before the next spend.
- Contention candidates now receive iteration-specific data markers, avoiding
  repeated transaction IDs during multi-batch preparation.

### Measured preparation

Command:

```text
npm run cauldron:hf -- --prepare --mode=sequential --iterations=1000 --workers=1 --order-sats=10000 --max-input-sats=10000000
```

Chipnet, Riften indexer, and the pinned `bch-ninja` Electrum endpoint were
used. The run passed in 52,417 ms with 1,000 signed candidates and zero
broadcasts. It touched 1,000 successive pool outpoints, reached pending
dependency depth 1,000, and ended with 1 active native BCH change UTXO plus 6
active pool successor UTXOs tracked in memory. Fee evidence across all 1,000
samples ranged from 445 to 447 bytes and 445 to 447 sats; every sample passed
the exact 1 sat/byte check. Initial Electrum state had zero unconfirmed wallet
UTXOs and zero unconfirmed pool outputs.

`npm run typecheck`, `npm test` (4 tests), and `git diff --check` passed. No
live 1,000-transaction broadcast was attempted.

### UTXO and relay assessment

The local UTXO boundary is handled and measured. The prepared graph is a
single unconfirmed dependency chain, however, so node mempool/relay policy is
the unresolved boundary; successful local signing and VM validation do not
guarantee that a public endpoint will accept all 1,000 descendants. The next
live test should begin with a small sequential boundary batch and stop on the
first `missing inputs`, ancestor-limit, or visibility error. Sustaining 1,000
simultaneous unconfirmed transactions may require a fan-out of independent BCH
and pool roots rather than one 1,000-deep chain.

## Iteration 7 — Live 1,000-transaction sequential batch

### Command and result

The explicitly authorized live command was run on Chipnet with one pinned
Electrum endpoint, 1,000 iterations, 10,000 sats per order, and a 10,000,000
sat input cap. It completed in 191,332 ms with status `completed`.

Measured runner metrics:

- 1,000 candidates signed and 1,000 transactions attempted;
- 1,000 endpoint acknowledgements and 1,000 endpoint visibility checks;
- 0 rejects, retries, conflicts, give-ups, or visibility failures;
- 1,000 unique pool outpoints touched;
- average build latency 40 ms and broadcast/visibility latency 151 ms;
- serialized size 445–447 bytes and fee 445–447 sats, with exact 1 sat/byte
  true for all 1,000 samples;
- maximum pending dependency depth 1,000; final local state retained 1 native
  change UTXO and 6 active pool successor UTXOs.

### Post-batch state

- `npm run cauldron:verify-pools` passed with Riften showing 3 matching pools,
  30,144,708 pool sats, and 9,357 PUSD units. Electrum showed the same 3
  unspent pool outputs and aggregate sats; both `indexed` and
  `pendingOrConfirmedOnElectrum` were true.
- `npm run verify:wallet` observed 1,003 wallet UTXOs, 1,002 token UTXOs,
  1,002 PUSD UTXOs, and 1 unconfirmed history entry. Its nonzero exit remains
  expected because it checks the obsolete 500,000,000-satoshi pre-setup
  baseline; its aggregate sat total includes token-bearing outputs and is not
  the runner's native-only balance.

### Assessment

The public Chipnet endpoint accepted and exposed the entire 1,000-deep
unconfirmed sequence to the runner, so this experiment achieved its target.
The remaining unconfirmed tip should be allowed to settle before another
spend batch. No raw transactions, signatures, wallet identifiers, or secret
material were recorded.

## Iteration 8 — Mixed buy/sell position-preservation preparation

### Hypothesis

Alternating BCH-to-PUSD buys and PUSD-to-BCH sells can preserve the wallet's
PUSD position while exercising both directions against unconfirmed pool and
wallet UTXOs.

### Changes

- Added `--flow=mixed`, restricted to sequential mode.
- Sell legs consume a PUSD UTXO matching the configured buy demand when
  possible, rather than selecting an arbitrary token lot.
- The local ledger now tracks native BCH, PUSD, and pool UTXOs together,
  including token change outputs and unconfirmed origins.
- Runner output includes initial and pending PUSD UTXO/unit counts.

### Measured preparation

Command:

```text
npm run cauldron:hf -- --prepare --flow=mixed --mode=sequential --iterations=4 --workers=1 --order-sats=10000 --max-input-sats=1000000
```

The preparation passed with 4 signed candidates and zero broadcasts. Initial
wallet position was 3,004 PUSD units across 1,002 PUSD UTXOs; the prepared
ending position was also 3,004 PUSD units across 1,002 PUSD UTXOs. The run
touched 4 pool outpoints, reached dependency depth 4, and passed exact
1 sat/byte validation for all candidates. Fee samples ranged from 447 to 586
bytes/sats. No live mixed-flow batch has been broadcast yet.

The planned live 1,000-leg command alternates 500 buys and 500 sells. BCH
position variance will include pool pricing and transaction fees; PUSD unit
variance should remain near zero when matching lots are available.
