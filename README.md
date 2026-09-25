# Cauldron Chipnet transaction bot

This is a controlled research harness for BCH/CashTokens transaction-contention
experiments. It is not a production wallet.

## Local wallet prerequisite

The read-only wallet prerequisite is intentionally a local command. It reads
`OPTN_TXBOT_MNEMONIC` from the local `.env`, derives the first receive address
using:

```text
m/44'/1'/0'/0/0
```

and queries the configured Chipnet Electrum fallbacks. It prints aggregate
balances and counts only; it does not print the mnemonic, address, script hash,
or UTXOs.

Before the setup transaction, this baseline command reports the original
funding amount. After setup spends and redistributes funds, use its aggregate
balance and UTXO counts as diagnostics rather than expecting the original
500,000,000-satoshi value:

```text
npm run verify:wallet
```

The command succeeds only when the first address reports exactly `500000000`
satoshis.

## Cauldron market dry-run

The Chipnet Cauldron indexer is the Riften Labs endpoint used by OPTNWallet:

```text
https://indexer-chipnet.riften.net/cauldron
```

Run a read-only BCH-to-token plan against the currently active indexed pools:

```text
npm run probe:cauldron
```

The default token is Chipnet PUSD (`dfe50223c8d5cba8dcef8dff6d92b61deb88a8ba44947367f2b746487b56039b`).
Optional non-secret overrides are `CAULDRON_TOKEN_ID`, `CAULDRON_SUPPLY_SATS`,
`CAULDRON_TOKEN_LIMIT`, and `CAULDRON_CHIPNET_INDEXER_URL`. The command does
not sign or broadcast.

## Purchase PUSD and create pools

`cauldron:setup` plans a CashLab PUSD purchase followed by three pool outputs,
using Riften's active Chipnet pool data and the wallet's first receive path.
The defaults target up to 30,000,000 sats for the purchase and 10,000,000 sats
of BCH reserve per pool (up to 60,000,000 sats committed before fees). The plan
is read-only and does not sign or broadcast:

```text
npm run cauldron:setup
```

Execution requires the explicit `--execute` flag:

```text
npm run cauldron:setup -- --execute
```

Execution signs and broadcasts the PUSD purchase, waits for the wallet's
Chipnet UTXO view to show the purchased PUSD, then builds, validates, signs,
and broadcasts the three-pool transaction. It verifies the token category,
pool script, reserve amounts, BCH VM validity, and exact 1 sat/byte serialized
fees. The script prints transaction IDs and aggregate transaction evidence,
never raw transactions or wallet material.

On rerun, the script checks the wallet-owned Cauldron locking script first. If
it already sees all three pool outputs, it exits without signing or
broadcasting and reports whether Riften has indexed them. If PUSD remains but
the pool outputs are incomplete, it refuses to make another purchase; review
the wallet and pending transactions before recovery.

## High-frequency test harness

The high-frequency runner uses live Electrum UTXOs as the state authority and
merges in Riften's indexed pools. This allows testing while Riften catches up
with the wallet-owned pools. It is plan-only by default:

```text
npm run cauldron:hf
```

To construct and validate signed candidates without broadcasting:

```text
npm run cauldron:hf -- --prepare --iterations=10 --order-sats=10000
```

For a sequential Chipnet run, execution is explicit and bounded:

```text
npm run cauldron:hf -- --execute --mode=sequential --iterations=10 --workers=1 --order-sats=10000 --max-input-sats=1000000
```

For an intentional contention batch, use at least two workers. Workers build
different transactions from the same pool/wallet snapshot, so conflicts are
expected and measured:

```text
npm run cauldron:hf -- --execute --mode=contention --iterations=1 --workers=4 --order-sats=10000 --max-input-sats=1000000
```

For a 1,000-transaction unconfirmed-chain preparation run, which signs in
memory but does not broadcast, use:

```text
npm run cauldron:hf -- --prepare --mode=sequential --iterations=1000 --workers=1 --order-sats=10000 --max-input-sats=10000000
```

The sequential runner maintains a local UTXO ledger: each candidate must spend
only active native/pool outpoints, then its unconfirmed BCH change and pool
successors become the next candidate's inputs. It advances this ledger during
`--prepare`, so preparation does not repeatedly sign the same transaction. It
also pins broadcasts to one Electrum endpoint, checks that each accepted
transaction is visible there before allowing a child transaction, and records
pending dependency depth. This makes unconfirmed-chain failures explicit
instead of silently building from stale confirmed state.

The runner caps iterations at 1,000, workers at 8, order size at 100,000 sats,
and requires the attempted input total to remain below the explicit maximum.
It reports endpoint acknowledgements separately from transaction visibility,
accepted/rejected transactions, first-endpoint success, retries, give-ups,
conflicts, insufficient-liquidity stops, latency, pending dependency depth,
and unique pools.
