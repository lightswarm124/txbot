import { createHash } from 'node:crypto';
import { config as loadDotenv } from 'dotenv';
import {
  binToHex,
  createVirtualMachineBCH,
  deriveHdPath,
  deriveHdPrivateNodeFromBip39Mnemonic,
  deriveHdPublicNode,
  encodeTransaction,
  hash160,
  hashTransaction,
  hexToBin,
} from '@bitauth/libauth';
import { ElectrumClient } from '@electrum-cash/network';
import { ElectrumTcpSocket } from '@electrum-cash/tcp-socket';
import { ElectrumWebSocket } from '@electrum-cash/web-socket';
import { ExchangeLab } from '@cashlab/cauldron';
import type { PoolV0 } from '@cashlab/cauldron/types.js';
import {
  createPayoutTx,
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

const DERIVATION_PATH = "m/44'/1'/0'/0/0";
const POOL_COUNT = 3;
const POOL_RESERVE_SATS = 10_000_000n;
const BUY_BUDGET_SATS = 30_000_000n;
const MAX_SETUP_BUDGET_SATS = 60_000_000n;
const TOKEN_WAIT_MS = 90_000;
const TOKEN_POLL_MS = 3_000;
const POOL_COUNT_BIGINT = BigInt(POOL_COUNT);

type ElectrumUtxo = {
  tx_hash: string;
  tx_pos: number;
  value: number | string;
  height: number;
  token_data?: unknown;
};

type Wallet = {
  key: Uint8Array;
  pkh: Uint8Array;
  lockingBytecode: Uint8Array;
  scriptHash: string;
};

function parseTokenData(value: unknown): { category: string; amount: bigint; hasNft: boolean } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  const category = row.category;
  const amount = row.amount;
  if (
    typeof category !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(category) ||
    (typeof amount !== 'string' && typeof amount !== 'number') ||
    !/^\d+$/.test(String(amount))
  ) {
    throw new Error('Electrum returned an unsupported CashToken UTXO shape');
  }
  return { category: category.toLowerCase(), amount: BigInt(amount), hasNft: row.nft != null };
}

function makeWallet(mnemonic: string): Wallet {
  const master = deriveHdPrivateNodeFromBip39Mnemonic(mnemonic, { passphrase: '' });
  const child = deriveHdPath(master, DERIVATION_PATH);
  const publicKey = deriveHdPublicNode(child).publicKey;
  const pkh = hash160(publicKey);
  const lockingBytecode = new Uint8Array(25);
  lockingBytecode.set([0x76, 0xa9, 0x14], 0);
  lockingBytecode.set(pkh, 3);
  lockingBytecode.set([0x88, 0xac], 23);
  const scriptHash = createHash('sha256').update(lockingBytecode).digest().reverse().toString('hex');
  return { key: child.privateKey, pkh, lockingBytecode, scriptHash };
}

async function withElectrum<T>(
  endpointIndex: number,
  callback: (client: ElectrumClient<any>) => Promise<T>,
): Promise<T> {
  const endpoint = CHIPNET_ENDPOINTS[endpointIndex];
  if (!endpoint) throw new Error('Invalid Chipnet endpoint selection');
  const socket = endpoint.transport === 'wss'
    ? new ElectrumWebSocket(endpoint.host, { port: endpoint.port, encrypted: true })
    : new ElectrumTcpSocket(endpoint.host, { port: endpoint.port, encrypted: true });
  const client = new ElectrumClient('CauldronChipnetSetup', '1.4.1', socket);
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.disconnect(true).catch(() => undefined);
  }
}

async function listScriptUtxos(scriptHash: string): Promise<ElectrumUtxo[]> {
  let lastError: unknown;
  for (let index = 0; index < CHIPNET_ENDPOINTS.length; index++) {
    try {
      return await withElectrum(index, async (client) => {
        const result = await client.request(
          'blockchain.scripthash.listunspent', scriptHash, 'include_tokens',
        );
        if (!Array.isArray(result)) throw new Error('Electrum returned invalid UTXO list');
        return result as ElectrumUtxo[];
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`All Chipnet Electrum endpoints failed: ${lastError instanceof Error ? lastError.message : 'unknown error'}`);
}

async function listWalletUtxos(wallet: Wallet): Promise<ElectrumUtxo[]> {
  return listScriptUtxos(wallet.scriptHash);
}

function asCoins(utxos: ElectrumUtxo[], wallet: Wallet): SpendableCoin[] {
  return utxos.map((utxo) => {
    if (!/^[0-9a-f]{64}$/i.test(utxo.tx_hash) || !Number.isSafeInteger(utxo.tx_pos) || utxo.tx_pos < 0) {
      throw new Error('Electrum returned an invalid outpoint');
    }
    const token = parseTokenData(utxo.token_data);
    if (token?.hasNft) throw new Error('NFT UTXOs are excluded from automated setup');
    return {
      type: SpendableCoinType.P2PKH,
      key: wallet.key,
      // Electrum tx_hash and libauth outpointTransactionHash use UI/display order;
      // libauth reverses the bytes when serializing the transaction input.
      outpoint: { txhash: hexToBin(utxo.tx_hash), index: utxo.tx_pos },
      output: {
        locking_bytecode: wallet.lockingBytecode,
        amount: BigInt(utxo.value),
        ...(token ? { token: { token_id: token.category, amount: token.amount } } : {}),
      },
    };
  });
}

function toCashLabPools(rows: Awaited<ReturnType<CauldronIndexerClient['listActivePools']>>, lab: ExchangeLab): PoolV0[] {
  return rows.map((pool) => ({
    version: '0',
    parameters: { withdraw_pubkey_hash: hexToBin(pool.ownerPkh) },
    // The indexer txid is UI/display order, matching libauth's transaction API.
    outpoint: { txhash: hexToBin(pool.txid), index: pool.txPos },
    output: {
      locking_bytecode: lab.generatePoolV0LockingBytecode({ withdraw_pubkey_hash: hexToBin(pool.ownerPkh) }),
      token: { token_id: pool.tokenId, amount: pool.tokens },
      amount: pool.sats,
    },
  }));
}

async function retainUnspentPools(
  rows: Awaited<ReturnType<CauldronIndexerClient['listActivePools']>>,
  lab: ExchangeLab,
): Promise<Awaited<ReturnType<CauldronIndexerClient['listActivePools']>>> {
  const checks = await Promise.all(rows.map(async (pool) => {
    const lockingBytecode = lab.generatePoolV0LockingBytecode({
      withdraw_pubkey_hash: hexToBin(pool.ownerPkh),
    });
    const scriptHash = createHash('sha256')
      .update(lockingBytecode)
      .digest()
      .reverse()
      .toString('hex');
    const utxos = await listScriptUtxos(scriptHash);
    const live = utxos.find((utxo) =>
      utxo.tx_hash.toLowerCase() === pool.txid && utxo.tx_pos === pool.txPos,
    );
    if (!live) return null;
    const token = parseTokenData(live.token_data);
    if (
      BigInt(live.value) !== pool.sats ||
      token?.category !== CAULDRON_PUSD_TOKEN_ID ||
      token.amount !== pool.tokens ||
      token.hasNft
    ) {
      throw new Error('Live pool UTXO does not match the indexed BCH and PUSD state');
    }
    return pool;
  }));
  return checks.filter((pool): pool is NonNullable<typeof pool> => pool !== null);
}

async function listOwnedPoolOutputs(wallet: Wallet, lab: ExchangeLab): Promise<ElectrumUtxo[]> {
  const lockingBytecode = lab.generatePoolV0LockingBytecode({ withdraw_pubkey_hash: wallet.pkh });
  const scriptHash = createHash('sha256')
    .update(lockingBytecode)
    .digest()
    .reverse()
    .toString('hex');
  const outputs = await listScriptUtxos(scriptHash);
  return outputs.filter((utxo) => {
    const token = parseTokenData(utxo.token_data);
    return token?.category === CAULDRON_PUSD_TOKEN_ID &&
      !token.hasNft &&
      BigInt(utxo.value) === POOL_RESERVE_SATS &&
      token.amount > 0n;
  });
}

function broadcastResultHex(result: unknown): string {
  if (typeof result !== 'string' || !/^[0-9a-f]{64}$/i.test(result)) {
    throw new Error('Electrum broadcast response was not a transaction ID');
  }
  return result.toLowerCase();
}

function safeBroadcastError(result: unknown): string {
  if (result instanceof Error) {
    const cause = result.cause;
    const details = cause && typeof cause === 'object'
      ? cause as Record<string, unknown>
      : undefined;
    const code = typeof details?.code === 'number' ? `RPC ${details.code}: ` : '';
    const message = typeof details?.message === 'string' ? details.message : result.message;
    return `${code}${message.replace(/[0-9a-f]{64,}/gi, '[hex redacted]').replace(/\s+/g, ' ').slice(0, 180)}`;
  }
  if (typeof result === 'string') return `unexpected string response (${result.length} characters)`;
  if (result && typeof result === 'object') return `unexpected response object (${Object.keys(result).slice(0, 8).join(', ')})`;
  return 'unexpected empty or non-string response';
}

async function broadcast(txbin: Uint8Array, txid: string): Promise<void> {
  const raw = binToHex(txbin);
  const failures: string[] = [];
  for (let index = 0; index < CHIPNET_ENDPOINTS.length; index++) {
    const endpoint = CHIPNET_ENDPOINTS[index];
    if (!endpoint) continue;
    try {
      const response = await withElectrum(index, (client) =>
        client.request('blockchain.transaction.broadcast', raw),
      );
      if (response instanceof Error) {
        failures.push(`${endpoint.name}: ${safeBroadcastError(response)}`);
        continue;
      }
      let receivedTxid: string;
      try {
        receivedTxid = broadcastResultHex(response);
      } catch {
        throw new Error(`${endpoint.name}: ${safeBroadcastError(response)}`);
      }
      if (receivedTxid !== txid) throw new Error(`${endpoint.name}: Electrum returned a mismatched transaction ID`);
      return;
    } catch (error) {
      failures.push(error instanceof Error ? error.message : `${endpoint.name}: unknown failure`);
    }
  }
  throw new Error(`Chipnet broadcast failed on all endpoints: ${failures.join(' | ')}`);
}

function outputTokenCategory(output: { token?: { category?: Uint8Array } }): string | undefined {
  return output.token?.category ? binToHex(output.token.category) : undefined;
}

async function waitForPusd(wallet: Wallet, minimum: bigint): Promise<ElectrumUtxo[]> {
  const deadline = Date.now() + TOKEN_WAIT_MS;
  while (Date.now() < deadline) {
    const utxos = await listWalletUtxos(wallet);
    const available = utxos.reduce((sum, utxo) => {
      const token = parseTokenData(utxo.token_data);
      return sum + (token?.category === CAULDRON_PUSD_TOKEN_ID ? token.amount : 0n);
    }, 0n);
    if (available >= minimum) return utxos;
    await new Promise((resolve) => setTimeout(resolve, TOKEN_POLL_MS));
  }
  throw new Error('PUSD purchase was accepted, but the wallet UTXO view did not reach the required token balance in time');
}

async function main(): Promise<void> {
  loadDotenv({ path: `${process.cwd()}/.env`, override: false });
  const execute = process.argv.includes('--execute');
  const mnemonic = process.env.OPTN_TXBOT_MNEMONIC?.trim();
  if (!mnemonic) throw new Error('OPTN_TXBOT_MNEMONIC is required in the local environment');

  const wallet = makeWallet(mnemonic);
  const lab = new ExchangeLab();
  const indexer = new CauldronIndexerClient();
  const [tokenRows, poolRows, walletUtxos] = await Promise.all([
    indexer.listCachedTokens(),
    indexer.listActivePools(CAULDRON_PUSD_TOKEN_ID),
    listWalletUtxos(wallet),
  ]);
  const token = tokenRows.find((row) => row.tokenId === CAULDRON_PUSD_TOKEN_ID);
  if (!token || poolRows.length === 0) throw new Error('PUSD metadata or active Cauldron pools are unavailable');
  if (poolRows.some((row) => row.tokenId !== CAULDRON_PUSD_TOKEN_ID)) throw new Error('Indexer returned a mismatched token category');

  const coins = asCoins(walletUtxos, wallet);
  const nativeSats = coins.reduce(
    (sum, coin) => sum + (coin.output.token ? 0n : coin.output.amount),
    0n,
  );
  if (nativeSats < BUY_BUDGET_SATS + POOL_COUNT_BIGINT * POOL_RESERVE_SATS + 2_000n) {
    throw new Error('Wallet native-BCH balance is below the hard setup budget plus fees');
  }
  if (BUY_BUDGET_SATS + POOL_COUNT_BIGINT * POOL_RESERVE_SATS > MAX_SETUP_BUDGET_SATS) {
    throw new Error('Configured setup exceeds the hard BCH committed-spend cap');
  }

  const livePoolRows = await retainUnspentPools(poolRows, lab);
  if (livePoolRows.length === 0) throw new Error('Riften indexed pools are stale or currently spent; no matching unspent Chipnet pool UTXOs were found');
  const existingPusd = coins.reduce((sum, coin) =>
    sum + (coin.output.token?.token_id === CAULDRON_PUSD_TOKEN_ID ? coin.output.token.amount : 0n), 0n);
  const ownedPoolOutputs = await listOwnedPoolOutputs(wallet, lab);
  if (ownedPoolOutputs.length >= POOL_COUNT) {
    const indexedOwnedPools = poolRows.filter((pool) =>
      pool.ownerPkh === binToHex(wallet.pkh) && pool.tokenId === CAULDRON_PUSD_TOKEN_ID,
    );
    const confirmedPoolOutputs = ownedPoolOutputs.filter((utxo) => utxo.height > 0).length;
    console.log(JSON.stringify({
      mode: execute ? 'execute' : 'plan-only',
      network: 'chipnet',
      status: indexedOwnedPools.length >= POOL_COUNT ? 'pools-indexed' : 'pool-outputs-pending-indexer',
      poolOutputsSeenByElectrum: ownedPoolOutputs.length,
      confirmedPoolOutputs,
      indexedOwnedPools: indexedOwnedPools.length,
      signing: false,
      broadcast: false,
    }));
    return;
  }
  const marketPools = toCashLabPools(livePoolRows, lab);
  const trade = lab.constructTradeBestRateForTargetSupply(
    'BCH', CAULDRON_PUSD_TOKEN_ID, BUY_BUDGET_SATS, marketPools, FEE_RATE_SATS_PER_BYTE,
  );
  if (trade.entries.length === 0 || trade.summary.demand <= POOL_COUNT_BIGINT * lab.getMinTokenReserve(CAULDRON_PUSD_TOKEN_ID)) {
    throw new Error('Cauldron quote does not provide enough PUSD reserve for three pools');
  }

  if (existingPusd > 0n) throw new Error('Wallet already has PUSD; refusing to buy again. Review the wallet before using a pool-only recovery flow.');

  const planned = {
    mode: execute ? 'execute' : 'plan-only',
    network: 'chipnet',
    tokenId: CAULDRON_PUSD_TOKEN_ID,
    activePools: livePoolRows.length,
    newPools: POOL_COUNT,
    buyBudgetSats: trade.summary.supply.toString(),
    quotedPusdUnits: trade.summary.demand.toString(),
    poolReserveSatsEach: POOL_RESERVE_SATS.toString(),
    maxCommittedSats: MAX_SETUP_BUDGET_SATS.toString(),
    existingWalletPusdUtxos: 0,
    signing: execute,
    broadcast: execute,
  };
  if (!execute) {
    console.log(JSON.stringify(planned));
    return;
  }

  const buyResult = lab.createTradeTx(
    trade.entries,
    coins.filter((coin) => !coin.output.token),
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
    null,
    FEE_RATE_SATS_PER_BYTE,
  );
  lab.verifyTradeTx(buyResult);
  const buySize = buyResult.txbin.length;
  assertExactOneSatPerByte(buySize, buyResult.txfee);
  const buyTxid = hashTransaction(encodeTransaction(buyResult.libauth_generated_transaction));
  if (!buyResult.libauth_generated_transaction.outputs.some((output) =>
    outputTokenCategory(output) === CAULDRON_PUSD_TOKEN_ID &&
    binToHex(output.lockingBytecode) === binToHex(wallet.lockingBytecode) &&
    output.token?.amount === trade.summary.demand,
  )) {
    throw new Error('Built purchase transaction has no output for the configured PUSD category');
  }
  if (buyResult.token_burns.length !== 0) throw new Error('Purchase transaction unexpectedly burns CashTokens');

  await broadcast(buyResult.txbin, buyTxid);
  const refreshedUtxos = await waitForPusd(wallet, BigInt(POOL_COUNT) * lab.getMinTokenReserve(CAULDRON_PUSD_TOKEN_ID));
  const poolCoins = asCoins(refreshedUtxos, wallet).filter((coin) =>
    !coin.output.token || coin.output.token.token_id === CAULDRON_PUSD_TOKEN_ID,
  );
  const pusdAmount = poolCoins.reduce((sum, coin) =>
    sum + (coin.output.token?.token_id === CAULDRON_PUSD_TOKEN_ID ? coin.output.token.amount : 0n), 0n);
  const perPoolTokens = pusdAmount / POOL_COUNT_BIGINT;
  if (perPoolTokens < lab.getMinTokenReserve(CAULDRON_PUSD_TOKEN_ID)) throw new Error('PUSD available after purchase is below pool reserve minimum');

  const poolLockingBytecode = lab.generatePoolV0LockingBytecode({ withdraw_pubkey_hash: wallet.pkh });
  const poolRules = Array.from({ length: POOL_COUNT }, () => ({
    type: PayoutAmountRuleType.FIXED,
    locking_bytecode: poolLockingBytecode,
    amount: POOL_RESERVE_SATS,
    token: { token_id: CAULDRON_PUSD_TOKEN_ID, amount: perPoolTokens },
  }));
  const poolResult = createPayoutTx(
    {
      txfee_per_byte: FEE_RATE_SATS_PER_BYTE,
      getOutputMinAmount: (output) => lab.getOutputMinAmount(output),
      getPreferredTokenOutputBCHAmount: (output) => lab.getPreferredTokenOutputBCHAmount(output),
    },
    poolCoins,
    [
      ...poolRules,
      {
        type: PayoutAmountRuleType.CHANGE,
        locking_bytecode: wallet.lockingBytecode,
        spending_parameters: { type: SpendableCoinType.P2PKH, key: wallet.key },
      },
    ],
  );
  const poolSize = poolResult.txbin.length;
  assertExactOneSatPerByte(poolSize, poolResult.txfee);
  const vmResult = createVirtualMachineBCH().verify({
    sourceOutputs: poolResult.libauth_source_outputs,
    transaction: poolResult.libauth_transaction,
  });
  if (typeof vmResult === 'string') throw new Error('Pool transaction failed BCH virtual-machine validation');
  const actualPools = poolResult.libauth_transaction.outputs.filter((output) =>
    outputTokenCategory(output) === CAULDRON_PUSD_TOKEN_ID &&
    output.valueSatoshis === POOL_RESERVE_SATS &&
    output.token?.amount === perPoolTokens &&
    binToHex(output.lockingBytecode) === binToHex(poolLockingBytecode),
  );
  if (actualPools.length !== POOL_COUNT) throw new Error('Pool transaction output validation failed');
  const poolTxid = hashTransaction(encodeTransaction(poolResult.libauth_transaction));

  await broadcast(poolResult.txbin, poolTxid);
  console.log(JSON.stringify({
    ...planned,
    status: 'broadcast-accepted',
    buyTxid,
    buySizeBytes: buySize,
    buyFeeSats: buyResult.txfee.toString(),
    poolTxid,
    poolSizeBytes: poolSize,
    poolFeeSats: poolResult.txfee.toString(),
    pusdUnitsPerPool: perPoolTokens.toString(),
  }));
}

main().catch((error: unknown) => {
  // Errors are sanitized: never dump keys, inputs, serialized transactions, or wallet objects.
  console.error(error instanceof Error ? error.message : 'Cauldron setup failed');
  process.exitCode = 1;
});
