import {
  binToHex,
  createVirtualMachineBCH,
  encodeTransaction,
  hashTransaction,
  hexToBin,
} from '@bitauth/libauth';
import { ExchangeLab } from '@cashlab/cauldron';
import type { PoolV0, TradeResult, TradeTxResult } from '@cashlab/cauldron/types.js';
import {
  PayoutAmountRuleType,
  SpendableCoinType,
} from '@cashlab/common';
import type { SpendableCoin } from '@cashlab/common/types.js';

import {
  CAULDRON_PUSD_TOKEN_ID,
  CHIPNET_ENDPOINTS,
  FEE_RATE_SATS_PER_BYTE,
} from './config.js';
import { CauldronIndexerClient } from './cauldronIndexer.js';
import { assertExactOneSatPerByte } from './feePolicy.js';
import {
  broadcastTransaction,
  discoverLivePools,
  loadWalletFromEnvironment,
  parseTokenData,
  listScriptUtxos,
  toSpendableCoins,
  type BroadcastOutcome,
  type LivePool,
  type Wallet,
} from './cauldronRuntime.js';

const DEFAULT_ITERATIONS = 10;
const DEFAULT_WORKERS = 1;
const DEFAULT_ORDER_SATS = 10_000n;
const DEFAULT_MAX_INPUT_SATS = 1_000_000n;
const MAX_ITERATIONS = 1_000;
const MAX_WORKERS = 8;
const MAX_ORDER_SATS = 100_000n;
const DEFAULT_BROADCAST_ENDPOINT_INDEX = 0;
const DEFAULT_VISIBILITY_ATTEMPTS = 3;
const DEFAULT_VISIBILITY_DELAY_MS = 50;

type RunMode = 'sequential' | 'contention';
type Action = 'plan' | 'prepare' | 'execute';
type Flow = 'buy' | 'mixed';

type Config = {
  action: Action;
  flow: Flow;
  runMode: RunMode;
  iterations: number;
  workers: number;
  orderSats: bigint;
  maxInputSats: bigint;
  broadcastEndpointIndex: number;
  visibilityAttempts: number;
  visibilityDelayMs: number;
};

type UtxoOrigin = {
  txid: string;
  depth: number;
};

type UtxoState = {
  pools: LivePool[];
  nativeCoins: SpendableCoin[];
  tokenCoins: SpendableCoin[];
  origins: Map<string, UtxoOrigin>;
};

type BuiltTrade = {
  result: TradeTxResult;
  trade: TradeResult;
  txid: string;
  touchedPoolKeys: string[];
  inputKeys: string[];
  tokenInputKeys: string[];
  dependencyDepth: number;
  side: 'buy' | 'sell';
};

type Metrics = {
  requestedIterations: number;
  workers: number;
  attempts: number;
  accepted: number;
  rejected: number;
  retries: number;
  firstBroadcastSuccess: number;
  giveUps: number;
  conflicts: number;
  insufficientIdleLiquidity: number;
  uniquePoolsTouched: number;
  buildLatencyMs: number[];
  broadcastLatencyMs: number[];
  feeEvidence: Array<{ sizeBytes: number; feeSats: string }>;
  visibleBroadcasts: number;
  visibilityFailures: number;
  maxPendingDependencyDepth: number;
  errors: string[];
};

function readFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found?.slice(prefix.length);
}

function readPositiveInteger(name: string, fallback: number, max: number): number {
  const raw = readFlag(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new Error(`--${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

function readNonNegativeInteger(name: string, fallback: number, max: number): number {
  const raw = readFlag(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(`--${name} must be an integer between 0 and ${max}`);
  }
  return value;
}

function readPositiveBigInt(name: string, fallback: bigint, max: bigint): bigint {
  const raw = readFlag(name);
  const value = raw === undefined ? fallback : /^\d+$/.test(raw) ? BigInt(raw) : 0n;
  if (value <= 0n || value > max) throw new Error(`--${name} must be a positive integer no greater than ${max}`);
  return value;
}

function parseConfig(): Config {
  const action: Action = process.argv.includes('--execute')
    ? 'execute'
    : process.argv.includes('--prepare')
      ? 'prepare'
      : 'plan';
  const runMode = readFlag('mode') ?? 'sequential';
  if (runMode !== 'sequential' && runMode !== 'contention') {
    throw new Error('--mode must be sequential or contention');
  }
  const workers = readPositiveInteger('workers', DEFAULT_WORKERS, MAX_WORKERS);
  if (runMode === 'sequential' && workers !== 1) {
    throw new Error('sequential mode requires --workers=1');
  }
  if (runMode === 'contention' && workers < 2) {
    throw new Error('contention mode requires --workers of at least 2');
  }
  const flow = readFlag('flow') ?? 'buy';
  if (flow !== 'buy' && flow !== 'mixed') throw new Error('--flow must be buy or mixed');
  if (flow === 'mixed' && runMode !== 'sequential') {
    throw new Error('--flow=mixed currently requires --mode=sequential');
  }
  return {
    action,
    flow,
    runMode,
    iterations: readPositiveInteger('iterations', DEFAULT_ITERATIONS, MAX_ITERATIONS),
    workers,
    orderSats: readPositiveBigInt('order-sats', DEFAULT_ORDER_SATS, MAX_ORDER_SATS),
    maxInputSats: readPositiveBigInt('max-input-sats', DEFAULT_MAX_INPUT_SATS, 10_000_000n),
    broadcastEndpointIndex: readNonNegativeInteger(
      'broadcast-endpoint',
      DEFAULT_BROADCAST_ENDPOINT_INDEX,
      CHIPNET_ENDPOINTS.length - 1,
    ),
    visibilityAttempts: readPositiveInteger(
      'visibility-attempts',
      DEFAULT_VISIBILITY_ATTEMPTS,
      20,
    ),
    visibilityDelayMs: readNonNegativeInteger(
      'visibility-delay-ms',
      DEFAULT_VISIBILITY_DELAY_MS,
      5_000,
    ),
  };
}

function outpointKey(pool: PoolV0): string {
  return `${binToHex(pool.outpoint.txhash)}:${pool.outpoint.index}`;
}

function coinOutpointKey(coin: SpendableCoin): string {
  return `${binToHex(coin.outpoint.txhash)}:${coin.outpoint.index}`;
}

function activeUtxoKeys(state: UtxoState): Set<string> {
  return new Set([
    ...state.nativeCoins.map(coinOutpointKey),
    ...state.tokenCoins.map(coinOutpointKey),
    ...state.pools.map(outpointKey),
  ]);
}

function assertUniqueKeys(keys: string[], label: string): void {
  if (new Set(keys).size !== keys.length) throw new Error(`UTXO ledger duplicate ${label}`);
}

function assertUtxoState(state: UtxoState): void {
  const nativeKeys = state.nativeCoins.map(coinOutpointKey);
  const tokenKeys = state.tokenCoins.map(coinOutpointKey);
  const poolKeys = state.pools.map(outpointKey);
  assertUniqueKeys(nativeKeys, 'native input');
  assertUniqueKeys(tokenKeys, 'token input');
  assertUniqueKeys(poolKeys, 'pool input');
  const allKeys = [...nativeKeys, ...tokenKeys, ...poolKeys];
  const overlap = allKeys.length === new Set(allKeys).size ? undefined : 'overlap';
  if (overlap) throw new Error('UTXO ledger native/pool outpoint overlap');
  const active = new Set(allKeys);
  for (const key of state.origins.keys()) {
    if (!active.has(key)) throw new Error('UTXO ledger retained a spent outpoint');
  }
}

function resolveInputKey(
  input: { outpointTransactionHash: Uint8Array; outpointIndex: number },
  allowed: Set<string>,
): string {
  const raw = binToHex(input.outpointTransactionHash);
  const reversed = binToHex(Uint8Array.from(input.outpointTransactionHash).reverse());
  const rawKey = `${raw}:${input.outpointIndex}`;
  const reversedKey = `${reversed}:${input.outpointIndex}`;
  if (allowed.has(rawKey)) return rawKey;
  if (allowed.has(reversedKey)) return reversedKey;
  throw new Error('Candidate transaction spends an outpoint outside the local UTXO ledger');
}

function safeError(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown test error';
  return error.message.replace(/[0-9a-f]{64,}/gi, '[hex redacted]').replace(/\s+/g, ' ').slice(0, 180);
}

function classifyConflict(error: string | undefined): boolean {
  return /conflict|missing inputs|double.?spend|already spent|mempool|non.?final/i.test(error ?? '');
}

function dataLockingBytecode(iteration: number, worker: number): Uint8Array {
  return Uint8Array.from([
    0x6a,
    0x04,
    0x48,
    (iteration >> 8) & 0xff,
    iteration & 0xff,
    worker & 0xff,
  ]);
}

function buildBuyTrade(
  lab: ExchangeLab,
  wallet: Wallet,
  state: UtxoState,
  orderSats: bigint,
  iteration: number,
  worker: number,
): BuiltTrade {
  const trade = lab.constructTradeBestRateForTargetSupply(
    'BCH',
    CAULDRON_PUSD_TOKEN_ID,
    orderSats,
    state.pools,
    FEE_RATE_SATS_PER_BYTE,
  );
  if (trade.entries.length === 0 || trade.summary.demand <= 0n) {
    throw new Error('Cauldron returned no positive PUSD demand');
  }
  const result = lab.createTradeTx(
    trade.entries,
    state.nativeCoins,
    [
      {
        type: PayoutAmountRuleType.FIXED,
        locking_bytecode: wallet.lockingBytecode,
        amount: -1n,
        token: { token_id: CAULDRON_PUSD_TOKEN_ID, amount: trade.summary.demand },
      },
      {
        type: PayoutAmountRuleType.CHANGE,
        locking_bytecode: wallet.lockingBytecode,
        spending_parameters: { type: SpendableCoinType.P2PKH, key: wallet.key },
      },
    ],
    worker > 0 ? dataLockingBytecode(iteration, worker) : null,
    FEE_RATE_SATS_PER_BYTE,
  );
  lab.verifyTradeTx(result);
  const vmResult = createVirtualMachineBCH().verify({
    sourceOutputs: result.libauth_source_outputs,
    transaction: result.libauth_generated_transaction,
  });
  if (typeof vmResult === 'string') throw new Error('Candidate trade failed BCH virtual-machine validation');
  assertExactOneSatPerByte(result.txbin.length, result.txfee);
  if (result.token_burns.length !== 0) throw new Error('Candidate trade unexpectedly burns PUSD');

  const outputs = result.libauth_generated_transaction.outputs;
  const poolOutputs = outputs.slice(0, trade.entries.length);
  if (poolOutputs.some((output) =>
    !output.token || binToHex(output.token.category) !== CAULDRON_PUSD_TOKEN_ID || output.valueSatoshis <= 693n,
  )) {
    throw new Error('Candidate trade has an invalid successor pool output');
  }
  const walletPusdOutputs = result.payouts_info.filter((payout) =>
    binToHex(payout.output.locking_bytecode) === binToHex(wallet.lockingBytecode) &&
    payout.output.token?.token_id === CAULDRON_PUSD_TOKEN_ID &&
    payout.output.token.amount === trade.summary.demand,
  );
  if (walletPusdOutputs.length !== 1) throw new Error('Candidate trade has an invalid wallet PUSD payout');

  const allowedInputKeys = new Set([
    ...state.nativeCoins.map(coinOutpointKey),
    ...trade.entries.map((entry) => outpointKey(entry.pool)),
  ]);
  const inputKeys = result.libauth_generated_transaction.inputs.map((input) =>
    resolveInputKey(input, allowedInputKeys));
  assertUniqueKeys(inputKeys, 'candidate input');
  const ledgerKeys = activeUtxoKeys(state);
  if (inputKeys.some((key) => !ledgerKeys.has(key))) {
    throw new Error('Candidate transaction spends a stale or unavailable UTXO');
  }
  const dependencyDepth = Math.max(
    0,
    ...inputKeys.map((key) => state.origins.get(key)?.depth ?? 0),
  ) + 1;

  return {
    result,
    trade,
    txid: hashTransaction(encodeTransaction(result.libauth_generated_transaction)),
    touchedPoolKeys: trade.entries.map((entry) => outpointKey(entry.pool)),
    inputKeys,
    tokenInputKeys: [],
    dependencyDepth,
    side: 'buy',
  };
}

function buildSellTrade(
  lab: ExchangeLab,
  wallet: Wallet,
  state: UtxoState,
  iteration: number,
  targetTokenAmount: bigint,
): BuiltTrade {
  const tokenCoin = state.tokenCoins.find((coin) => coin.output.token?.amount === targetTokenAmount) ??
    state.tokenCoins.reduce<SpendableCoin | undefined>((closest, coin) => {
      if (!closest) return coin;
      const currentDistance = (coin.output.token?.amount ?? 0n) > targetTokenAmount
        ? (coin.output.token?.amount ?? 0n) - targetTokenAmount
        : targetTokenAmount - (coin.output.token?.amount ?? 0n);
      const closestDistance = (closest.output.token?.amount ?? 0n) > targetTokenAmount
        ? (closest.output.token?.amount ?? 0n) - targetTokenAmount
        : targetTokenAmount - (closest.output.token?.amount ?? 0n);
      return currentDistance < closestDistance ? coin : closest;
    }, undefined);
  const tokenAmount = tokenCoin?.output.token?.amount;
  if (!tokenCoin || tokenCoin.output.token?.token_id !== CAULDRON_PUSD_TOKEN_ID || !tokenAmount || tokenAmount <= 0n) {
    throw new Error('Mixed flow has no spendable PUSD UTXO for the sell leg');
  }
  const trade = lab.constructTradeBestRateForTargetSupply(
    CAULDRON_PUSD_TOKEN_ID,
    'BCH',
    tokenAmount,
    state.pools,
    FEE_RATE_SATS_PER_BYTE,
  );
  if (trade.entries.length === 0 || trade.summary.demand <= 0n) {
    throw new Error('Cauldron returned no positive BCH demand for the sell leg');
  }
  const result = lab.createTradeTx(
    trade.entries,
    [...state.nativeCoins, tokenCoin],
    [
      {
        type: PayoutAmountRuleType.FIXED,
        locking_bytecode: wallet.lockingBytecode,
        amount: trade.summary.demand,
      },
      {
        type: PayoutAmountRuleType.CHANGE,
        locking_bytecode: wallet.lockingBytecode,
        spending_parameters: { type: SpendableCoinType.P2PKH, key: wallet.key },
      },
    ],
    dataLockingBytecode(iteration, 0),
    FEE_RATE_SATS_PER_BYTE,
  );
  lab.verifyTradeTx(result);
  const vmResult = createVirtualMachineBCH().verify({
    sourceOutputs: result.libauth_source_outputs,
    transaction: result.libauth_generated_transaction,
  });
  if (typeof vmResult === 'string') throw new Error('Sell candidate failed BCH virtual-machine validation');
  assertExactOneSatPerByte(result.txbin.length, result.txfee);
  if (result.token_burns.length !== 0) throw new Error('Sell candidate unexpectedly burns PUSD');

  const outputs = result.libauth_generated_transaction.outputs;
  const poolOutputs = outputs.slice(0, trade.entries.length);
  if (poolOutputs.some((output) =>
    !output.token || binToHex(output.token.category) !== CAULDRON_PUSD_TOKEN_ID || output.valueSatoshis <= 693n,
  )) {
    throw new Error('Sell candidate has an invalid successor pool output');
  }
  const fixedBchOutputs = result.payouts_info.filter((payout) =>
    payout.payout_rule.type === PayoutAmountRuleType.FIXED &&
    binToHex(payout.output.locking_bytecode) === binToHex(wallet.lockingBytecode) &&
    !payout.output.token && payout.output.amount === trade.summary.demand,
  );
  if (fixedBchOutputs.length !== 1) throw new Error('Sell candidate has an invalid BCH payout');

  const allowedInputKeys = new Set([
    ...state.nativeCoins.map(coinOutpointKey),
    coinOutpointKey(tokenCoin),
    ...trade.entries.map((entry) => outpointKey(entry.pool)),
  ]);
  const inputKeys = result.libauth_generated_transaction.inputs.map((input) =>
    resolveInputKey(input, allowedInputKeys));
  assertUniqueKeys(inputKeys, 'sell candidate input');
  const ledgerKeys = activeUtxoKeys(state);
  if (inputKeys.some((key) => !ledgerKeys.has(key))) {
    throw new Error('Sell candidate spends a stale or unavailable UTXO');
  }
  const dependencyDepth = Math.max(
    0,
    ...inputKeys.map((key) => state.origins.get(key)?.depth ?? 0),
  ) + 1;
  return {
    result,
    trade,
    txid: hashTransaction(encodeTransaction(result.libauth_generated_transaction)),
    touchedPoolKeys: trade.entries.map((entry) => outpointKey(entry.pool)),
    inputKeys,
    tokenInputKeys: [coinOutpointKey(tokenCoin)],
    dependencyDepth,
    side: 'sell',
  };
}

function advancePoolState(pools: LivePool[], built: BuiltTrade): LivePool[] {
  const txhash = hexToBin(built.txid);
  const touched = new Set(built.touchedPoolKeys);
  const successors = built.trade.entries.map((entry, index) => {
    const output = built.result.libauth_generated_transaction.outputs[index];
    if (!output?.token) throw new Error('Missing successor pool output');
    const prior = pools.find((pool) => outpointKey(pool) === outpointKey(entry.pool));
    if (!prior) throw new Error('Missing live pool metadata for successor output');
    return {
      ...entry.pool,
      source: prior.source,
      ownerPkhHex: prior.ownerPkhHex,
      height: 0,
      outpoint: { txhash, index },
      output: {
        locking_bytecode: output.lockingBytecode,
        amount: output.valueSatoshis,
        token: {
          token_id: binToHex(output.token.category),
          amount: output.token.amount,
        },
      },
    };
  });
  return [...pools.filter((pool) => !touched.has(outpointKey(pool))), ...successors];
}

function advanceWalletState(wallet: Wallet, built: BuiltTrade): SpendableCoin[] {
  const txhash = hexToBin(built.txid);
  const payouts: SpendableCoin[] = built.result.payouts_info
    .filter((payout) => binToHex(payout.output.locking_bytecode) === binToHex(wallet.lockingBytecode))
    .map((payout) => ({
      type: SpendableCoinType.P2PKH,
      key: wallet.key,
      outpoint: { txhash, index: payout.index },
      output: payout.output,
    }));
  const native = payouts.filter((coin) => !coin.output.token);
  if (native.length === 0) throw new Error('Trade produced no native BCH change for the next iteration');
  return native;
}

function advanceUtxoState(state: UtxoState, wallet: Wallet, built: BuiltTrade): UtxoState {
  assertUtxoState(state);
  const active = activeUtxoKeys(state);
  for (const inputKey of built.inputKeys) {
    if (!active.has(inputKey)) throw new Error('UTXO ledger rejected a stale or double-spent input');
  }

  const nextPools = advancePoolState(state.pools, built);
  const nextNativeCoins = advanceWalletState(wallet, built);
  const consumedTokenKeys = new Set(built.tokenInputKeys);
  const nextTokenCoins: SpendableCoin[] = state.tokenCoins
    .filter((coin) => !consumedTokenKeys.has(coinOutpointKey(coin)))
    .concat(
      built.result.payouts_info
        .filter((payout) =>
          binToHex(payout.output.locking_bytecode) === binToHex(wallet.lockingBytecode) &&
          payout.output.token?.token_id === CAULDRON_PUSD_TOKEN_ID,
        )
        .map((payout) => ({
          type: SpendableCoinType.P2PKH,
          key: wallet.key,
          outpoint: { txhash: hexToBin(built.txid), index: payout.index },
          output: payout.output,
        })),
    );
  const origins = new Map(state.origins);
  for (const inputKey of built.inputKeys) origins.delete(inputKey);
  for (let index = 0; index < built.trade.entries.length; index++) {
    origins.set(`${built.txid}:${index}`, { txid: built.txid, depth: built.dependencyDepth });
  }
  for (const payout of built.result.payouts_info) {
    if (
      binToHex(payout.output.locking_bytecode) === binToHex(wallet.lockingBytecode) &&
      (!payout.output.token || payout.output.token.token_id === CAULDRON_PUSD_TOKEN_ID)
    ) {
      origins.set(`${built.txid}:${payout.index}`, { txid: built.txid, depth: built.dependencyDepth });
    }
  }
  const nextState = { pools: nextPools, nativeCoins: nextNativeCoins, tokenCoins: nextTokenCoins, origins };
  assertUtxoState(nextState);
  return nextState;
}

function createMetrics(config: Config): Metrics {
  return {
    requestedIterations: config.iterations,
    workers: config.workers,
    attempts: 0,
    accepted: 0,
    rejected: 0,
    retries: 0,
    firstBroadcastSuccess: 0,
    giveUps: 0,
    conflicts: 0,
    insufficientIdleLiquidity: 0,
    uniquePoolsTouched: 0,
    buildLatencyMs: [],
    broadcastLatencyMs: [],
    feeEvidence: [],
    visibleBroadcasts: 0,
    visibilityFailures: 0,
    maxPendingDependencyDepth: 0,
    errors: [],
  };
}

function summarizeMetrics(metrics: Metrics): Record<string, unknown> {
  const average = (values: number[]) => values.length === 0
    ? null
    : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  const feeEvidence = metrics.feeEvidence;
  const feeSizes = feeEvidence.map((sample) => sample.sizeBytes);
  const feeSats = feeEvidence.map((sample) => BigInt(sample.feeSats));
  return {
    ...metrics,
    buildLatencyMs: average(metrics.buildLatencyMs),
    broadcastLatencyMs: average(metrics.broadcastLatencyMs),
    feeEvidence: feeEvidence.length === 0 ? null : {
      samples: feeEvidence.length,
      minSizeBytes: Math.min(...feeSizes),
      maxSizeBytes: Math.max(...feeSizes),
      minFeeSats: (feeSats.reduce((min, value) => value < min ? value : min, feeSats[0] ?? 0n)).toString(),
      maxFeeSats: (feeSats.reduce((max, value) => value > max ? value : max, feeSats[0] ?? 0n)).toString(),
      exactOneSatPerByte: feeEvidence.every((sample) => BigInt(sample.sizeBytes) === BigInt(sample.feeSats)),
    },
  };
}

async function broadcastBuilt(
  built: BuiltTrade,
  metrics: Metrics,
  endpointIndex: number,
  visibilityAttempts: number,
  visibilityDelayMs: number,
): Promise<BroadcastOutcome> {
  const start = performance.now();
  const outcome = await broadcastTransaction(built.result.txbin, built.txid, {
    endpointIndex,
    visibilityAttempts,
    visibilityDelayMs,
  });
  metrics.broadcastLatencyMs.push(Math.round(performance.now() - start));
  metrics.retries += outcome.retries;
  if (outcome.firstEndpointSuccess) metrics.firstBroadcastSuccess++;
  if (outcome.visible) metrics.visibleBroadcasts++;
  if (outcome.accepted && !outcome.visible) metrics.visibilityFailures++;
  if (!outcome.accepted) {
    metrics.rejected++;
    metrics.giveUps++;
    if (classifyConflict(outcome.error)) metrics.conflicts++;
    if (outcome.error) metrics.errors.push(outcome.error);
  } else {
    metrics.accepted++;
  }
  if (outcome.error && outcome.accepted && !outcome.visible) metrics.errors.push(outcome.error);
  return outcome;
}

async function main(): Promise<void> {
  const config = parseConfig();
  const attemptedInputSats = config.orderSats * BigInt(config.iterations) * BigInt(config.workers);
  if (attemptedInputSats > config.maxInputSats) {
    throw new Error(`Configured attempts require ${attemptedInputSats} sats, above --max-input-sats=${config.maxInputSats}`);
  }

  const wallet = loadWalletFromEnvironment();
  const lab = new ExchangeLab();
  const indexer = new CauldronIndexerClient();
  const walletUtxos = await listScriptUtxos(wallet.scriptHash);
  const walletCoins = toSpendableCoins(walletUtxos, wallet);
  const nativeCoins = walletCoins.filter((coin) => !coin.output.token);
  const tokenCoins = walletCoins.filter((coin) =>
    coin.output.token?.token_id === CAULDRON_PUSD_TOKEN_ID,
  );
  const nativeBalance = nativeCoins.reduce((sum, coin) => sum + coin.output.amount, 0n);
  if (nativeBalance < attemptedInputSats) throw new Error('Native BCH balance is below the configured test input cap');

  const pools = await discoverLivePools(indexer, wallet, lab);
  if (pools.length === 0) throw new Error('No live PUSD pools were found on Electrum');
  const origins = new Map<string, UtxoOrigin>();
  const nativeKeys = new Set(nativeCoins.map(coinOutpointKey));
  const tokenKeys = new Set(tokenCoins.map(coinOutpointKey));
  for (const utxo of walletUtxos) {
    const key = `${utxo.tx_hash.toLowerCase()}:${utxo.tx_pos}`;
    if (utxo.height === 0 && (nativeKeys.has(key) || tokenKeys.has(key))) {
      origins.set(key, {
        txid: utxo.tx_hash.toLowerCase(),
        depth: 1,
      });
    }
  }
  for (const pool of pools) {
    if (pool.height === 0) {
      origins.set(`${outpointKey(pool)}`, {
        txid: binToHex(pool.outpoint.txhash),
        depth: 1,
      });
    }
  }
  let state: UtxoState = { pools, nativeCoins, tokenCoins, origins };
  assertUtxoState(state);
  const uniquePools = new Set<string>();
  const metrics = createMetrics(config);
  const initialQuote = lab.constructTradeBestRateForTargetSupply(
    'BCH', CAULDRON_PUSD_TOKEN_ID, config.orderSats, pools, FEE_RATE_SATS_PER_BYTE,
  );
  if (initialQuote.entries.length === 0 || initialQuote.summary.demand <= 0n) {
    metrics.insufficientIdleLiquidity++;
    throw new Error('No idle PUSD liquidity can satisfy the configured order');
  }
  for (const entry of initialQuote.entries) uniquePools.add(outpointKey(entry.pool));

  const base = {
    network: 'chipnet',
    tokenId: CAULDRON_PUSD_TOKEN_ID,
    action: config.action,
    flow: config.flow,
    runMode: config.runMode,
    iterations: config.iterations,
    workers: config.workers,
    orderSats: config.orderSats.toString(),
    attemptedInputSats: attemptedInputSats.toString(),
    maxInputSats: config.maxInputSats.toString(),
    livePoolCount: pools.length,
    indexedPoolCount: pools.filter((pool) => pool.source === 'indexer').length,
    walletOwnedPoolCount: pools.filter((pool) => pool.source === 'wallet').length,
    initialQuotedPusdUnits: initialQuote.summary.demand.toString(),
    initialPusdUtxoCount: tokenCoins.length,
    initialPusdUnits: tokenCoins.reduce((sum, coin) => sum + (coin.output.token?.amount ?? 0n), 0n).toString(),
    nativeWalletBalanceSats: nativeBalance.toString(),
    initialUnconfirmedWalletUtxos: walletUtxos.filter((utxo) => utxo.height === 0).length,
    initialUnconfirmedPoolOutputs: pools.filter((pool) => pool.height === 0).length,
    broadcastEndpoint: CHIPNET_ENDPOINTS[config.broadcastEndpointIndex]?.name,
    visibilityAttempts: config.visibilityAttempts,
    visibilityDelayMs: config.visibilityDelayMs,
    sourceOfTruth: 'Electrum live UTXOs merged with Riften indexed pools',
  };

  if (config.action === 'plan') {
    console.log(JSON.stringify({
      ...base,
      readyToPrepare: true,
      readyToExecute: config.runMode === 'sequential' || config.workers >= 2,
      signing: false,
      broadcast: false,
      metrics: summarizeMetrics(metrics),
    }));
    return;
  }

  let signedCandidates = 0;
  const start = performance.now();

  for (let iteration = 0; iteration < config.iterations; iteration++) {
    const batch: BuiltTrade[] = [];
    const batchBuildStart = performance.now();
    try {
      for (let worker = 0; worker < config.workers; worker++) {
        const mixedSell = config.flow === 'mixed' && iteration % 2 === 1;
        const built = mixedSell
          ? buildSellTrade(lab, wallet, state, iteration, initialQuote.summary.demand)
          : buildBuyTrade(
            lab,
            wallet,
            state,
            config.orderSats,
            iteration,
            config.runMode === 'contention' ? worker + 1 : 0,
          );
        batch.push(built);
        signedCandidates++;
        metrics.feeEvidence.push({
          sizeBytes: built.result.txbin.length,
          feeSats: built.result.txfee.toString(),
        });
        metrics.maxPendingDependencyDepth = Math.max(
          metrics.maxPendingDependencyDepth,
          built.dependencyDepth,
        );
        for (const key of built.touchedPoolKeys) uniquePools.add(key);
      }
    } catch (error) {
      const message = safeError(error);
      metrics.insufficientIdleLiquidity++;
      metrics.errors.push(message);
      if (config.action === 'prepare') break;
      throw new Error(`HF candidate construction stopped at iteration ${iteration + 1}: ${message}`);
    }
    const buildElapsed = Math.round(performance.now() - batchBuildStart);
    metrics.buildLatencyMs.push(Math.round(buildElapsed / batch.length));

    if (config.action === 'prepare') {
      if (config.runMode === 'sequential') {
        const built = batch[0];
        if (!built) throw new Error('Sequential preparation batch was empty');
        state = advanceUtxoState(state, wallet, built);
      }
      continue;
    }

    metrics.attempts += batch.length;
    if (config.runMode === 'contention') {
      const outcomes = await Promise.all(batch.map((built) => broadcastBuilt(
        built,
        metrics,
        config.broadcastEndpointIndex,
        config.visibilityAttempts,
        config.visibilityDelayMs,
      )));
      const accepted = outcomes.filter((outcome) => outcome.accepted);
      const chainable = outcomes.filter((outcome) => outcome.accepted && outcome.visible);
      if (accepted.length !== 1 || chainable.length !== 1) {
        metrics.errors.push(
          `contention batch ended with ${accepted.length} endpoint acknowledgements and ${chainable.length} visible transactions`,
        );
        break;
      }
      const winner = batch[outcomes.findIndex((outcome) => outcome.accepted && outcome.visible)];
      if (!winner) throw new Error('Accepted contention transaction was not found');
      state = advanceUtxoState(state, wallet, winner);
    } else {
      const built = batch[0];
      if (!built) throw new Error('Sequential batch was empty');
      const outcome = await broadcastBuilt(
        built,
        metrics,
        config.broadcastEndpointIndex,
        config.visibilityAttempts,
        config.visibilityDelayMs,
      );
      if (!outcome.accepted || !outcome.visible) break;
      state = advanceUtxoState(state, wallet, built);
    }
  }

  const status = config.action === 'prepare'
    ? (metrics.errors.length === 0 ? 'prepared' : 'prepared-with-errors')
    : metrics.rejected === 0 && metrics.accepted > 0 ? 'completed' : 'stopped-with-errors';
  console.log(JSON.stringify({
    ...base,
    status,
    signedCandidates,
    elapsedMs: Math.round(performance.now() - start),
    signing: true,
    broadcast: config.action === 'execute',
    metrics: {
      ...summarizeMetrics(metrics),
      uniquePoolsTouched: uniquePools.size,
      pendingNativeUtxos: state.nativeCoins.length,
      pendingPusdUtxos: state.tokenCoins.length,
      pendingPusdUnits: state.tokenCoins.reduce((sum, coin) => sum + (coin.output.token?.amount ?? 0n), 0n).toString(),
      pendingPoolOutputs: state.pools.filter((pool) => state.origins.has(outpointKey(pool))).length,
      pendingUtxoCount: state.origins.size,
    },
  }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Cauldron high-frequency test failed');
  process.exitCode = 1;
});
