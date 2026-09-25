import { createHash } from 'node:crypto';
import { config as loadDotenv } from 'dotenv';
import {
  binToHex,
  deriveHdPath,
  deriveHdPrivateNodeFromBip39Mnemonic,
  deriveHdPublicNode,
  hash160,
  hexToBin,
} from '@bitauth/libauth';
import { ElectrumClient } from '@electrum-cash/network';
import { ElectrumTcpSocket } from '@electrum-cash/tcp-socket';
import { ElectrumWebSocket } from '@electrum-cash/web-socket';
import { ExchangeLab } from '@cashlab/cauldron';
import type { PoolV0 } from '@cashlab/cauldron/types.js';
import { SpendableCoinType } from '@cashlab/common/constants.js';
import type { SpendableCoin } from '@cashlab/common/types.js';

import { CAULDRON_PUSD_TOKEN_ID, CHIPNET_ENDPOINTS } from './config.js';
import { CauldronIndexerClient, type CauldronActivePool } from './cauldronIndexer.js';

export const DERIVATION_PATH = "m/44'/1'/0'/0/0";

export type ElectrumUtxo = {
  tx_hash: string;
  tx_pos: number;
  value: number | string;
  height: number;
  token_data?: unknown;
};

export type Wallet = {
  key: Uint8Array;
  pkh: Uint8Array;
  lockingBytecode: Uint8Array;
  scriptHash: string;
};

export type LivePool = PoolV0 & {
  source: 'indexer' | 'wallet';
  ownerPkhHex: string;
  height: number;
};

export type BroadcastOptions = {
  endpointIndex?: number;
  visibilityAttempts?: number;
  visibilityDelayMs?: number;
};

export type BroadcastOutcome = {
  accepted: boolean;
  visible: boolean;
  endpointAttempts: number;
  retries: number;
  firstEndpointSuccess: boolean;
  endpointIndex?: number;
  visibilityChecks: number;
  error?: string;
};

export function loadWalletFromEnvironment(): Wallet {
  loadDotenv({ path: `${process.cwd()}/.env`, override: false });
  const mnemonic = process.env.OPTN_TXBOT_MNEMONIC?.trim();
  if (!mnemonic) throw new Error('OPTN_TXBOT_MNEMONIC is required in the local environment');
  const master = deriveHdPrivateNodeFromBip39Mnemonic(mnemonic, { passphrase: '' });
  const child = deriveHdPath(master, DERIVATION_PATH);
  const publicKey = deriveHdPublicNode(child).publicKey;
  const pkh = hash160(publicKey);
  const lockingBytecode = new Uint8Array(25);
  lockingBytecode.set([0x76, 0xa9, 0x14], 0);
  lockingBytecode.set(pkh, 3);
  lockingBytecode.set([0x88, 0xac], 23);
  const scriptHash = createHash('sha256')
    .update(lockingBytecode)
    .digest()
    .reverse()
    .toString('hex');
  return { key: child.privateKey, pkh, lockingBytecode, scriptHash };
}

function poolScriptHash(ownerPkh: Uint8Array, lab: ExchangeLab): string {
  const lockingBytecode = lab.generatePoolV0LockingBytecode({
    withdraw_pubkey_hash: ownerPkh,
  });
  return createHash('sha256')
    .update(lockingBytecode)
    .digest()
    .reverse()
    .toString('hex');
}

export function parseTokenData(
  value: unknown,
): { category: string; amount: bigint; hasNft: boolean } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  if (
    typeof row.category !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(row.category) ||
    (typeof row.amount !== 'string' && typeof row.amount !== 'number') ||
    !/^\d+$/.test(String(row.amount))
  ) {
    throw new Error('Electrum returned an unsupported CashToken UTXO shape');
  }
  return {
    category: row.category.toLowerCase(),
    amount: BigInt(row.amount),
    hasNft: row.nft != null,
  };
}

function validateUtxoHeight(height: number): void {
  if (!Number.isSafeInteger(height) || height < 0) {
    throw new Error('Electrum returned an invalid UTXO confirmation height');
  }
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
  const client = new ElectrumClient('CauldronChipnetHfTest', '1.4.1', socket);
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.disconnect(true).catch(() => undefined);
  }
}

export async function listScriptUtxos(scriptHash: string): Promise<ElectrumUtxo[]> {
  let lastError: unknown;
  for (let index = 0; index < CHIPNET_ENDPOINTS.length; index++) {
    try {
      return await withElectrum(index, async (client) => {
        const response = await client.request(
          'blockchain.scripthash.listunspent',
          scriptHash,
          'include_tokens',
        );
        if (!Array.isArray(response)) throw new Error('Electrum returned an invalid UTXO list');
        return response as ElectrumUtxo[];
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`All Chipnet Electrum endpoints failed: ${lastError instanceof Error ? lastError.message : 'unknown error'}`);
}

export function toSpendableCoins(utxos: ElectrumUtxo[], wallet: Wallet): SpendableCoin[] {
  return utxos.map((utxo) => {
    if (!/^[0-9a-f]{64}$/i.test(utxo.tx_hash) || !Number.isSafeInteger(utxo.tx_pos) || utxo.tx_pos < 0) {
      throw new Error('Electrum returned an invalid outpoint');
    }
    validateUtxoHeight(utxo.height);
    const token = parseTokenData(utxo.token_data);
    if (token?.hasNft) throw new Error('NFT UTXOs are excluded from the high-frequency test');
    return {
      type: SpendableCoinType.P2PKH,
      key: wallet.key,
      // Electrum exposes txids in UI order; libauth handles wire-order reversal.
      outpoint: { txhash: hexToBin(utxo.tx_hash), index: utxo.tx_pos },
      output: {
        locking_bytecode: wallet.lockingBytecode,
        amount: BigInt(utxo.value),
        ...(token ? { token: { token_id: token.category, amount: token.amount } } : {}),
      },
    };
  });
}

function livePoolFromIndexer(row: CauldronActivePool, lab: ExchangeLab, height: number): LivePool {
  const ownerPkh = hexToBin(row.ownerPkh);
  return {
    version: '0',
    parameters: { withdraw_pubkey_hash: ownerPkh },
    outpoint: { txhash: hexToBin(row.txid), index: row.txPos },
    output: {
      locking_bytecode: lab.generatePoolV0LockingBytecode({ withdraw_pubkey_hash: ownerPkh }),
      token: { token_id: row.tokenId, amount: row.tokens },
      amount: row.sats,
    },
    source: 'indexer',
    ownerPkhHex: row.ownerPkh,
    height,
  };
}

function livePoolFromUtxo(utxo: ElectrumUtxo, ownerPkh: Uint8Array, lab: ExchangeLab): LivePool | null {
  validateUtxoHeight(utxo.height);
  const token = parseTokenData(utxo.token_data);
  if (
    !token || token.category !== CAULDRON_PUSD_TOKEN_ID || token.hasNft ||
    !/^[0-9a-f]{64}$/i.test(utxo.tx_hash) || !Number.isSafeInteger(utxo.tx_pos) || utxo.tx_pos < 0
  ) return null;
  return {
    version: '0',
    parameters: { withdraw_pubkey_hash: ownerPkh },
    outpoint: { txhash: hexToBin(utxo.tx_hash), index: utxo.tx_pos },
    output: {
      locking_bytecode: lab.generatePoolV0LockingBytecode({ withdraw_pubkey_hash: ownerPkh }),
      token: { token_id: token.category, amount: token.amount },
      amount: BigInt(utxo.value),
    },
    source: 'wallet',
    ownerPkhHex: binToHex(ownerPkh),
    height: utxo.height,
  };
}

function outpointKey(pool: PoolV0): string {
  return `${binToHex(pool.outpoint.txhash)}:${pool.outpoint.index}`;
}

export async function discoverLivePools(
  indexer: CauldronIndexerClient,
  wallet: Wallet,
  lab: ExchangeLab,
): Promise<LivePool[]> {
  const indexedRows = await indexer.listActivePools(CAULDRON_PUSD_TOKEN_ID);
  const indexedLive: LivePool[] = [];
  for (const row of indexedRows) {
    const owner = hexToBin(row.ownerPkh);
    const utxos = await listScriptUtxos(poolScriptHash(owner, lab));
    const live = utxos.find((utxo) =>
      utxo.tx_hash.toLowerCase() === row.txid && utxo.tx_pos === row.txPos,
    );
    const token = live ? parseTokenData(live.token_data) : undefined;
    if (
      !live || BigInt(live.value) !== row.sats ||
      token?.category !== CAULDRON_PUSD_TOKEN_ID || token.amount !== row.tokens || token.hasNft
    ) continue;
    indexedLive.push(livePoolFromIndexer(row, lab, live.height));
  }

  const ownedUtxos = await listScriptUtxos(poolScriptHash(wallet.pkh, lab));
  const ownedLive = ownedUtxos
    .map((utxo) => livePoolFromUtxo(utxo, wallet.pkh, lab))
    .filter((pool): pool is LivePool => pool !== null);
  const unique = new Map<string, LivePool>();
  for (const pool of [...indexedLive, ...ownedLive]) unique.set(outpointKey(pool), pool);
  return [...unique.values()];
}

function safeError(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown broadcast error';
  const cause = error.cause && typeof error.cause === 'object'
    ? error.cause as Record<string, unknown>
    : undefined;
  const message = typeof cause?.message === 'string' ? cause.message : error.message;
  return message.replace(/[0-9a-f]{64,}/gi, '[hex redacted]').replace(/\s+/g, ' ').slice(0, 180);
}

export async function broadcastTransaction(
  txbin: Uint8Array,
  txid: string,
  options: BroadcastOptions = {},
): Promise<BroadcastOutcome> {
  const raw = binToHex(txbin);
  const errors: string[] = [];
  const visibilityAttempts = options.visibilityAttempts ?? 3;
  const visibilityDelayMs = options.visibilityDelayMs ?? 50;
  if (!Number.isSafeInteger(visibilityAttempts) || visibilityAttempts <= 0) {
    throw new Error('visibilityAttempts must be a positive integer');
  }
  if (!Number.isSafeInteger(visibilityDelayMs) || visibilityDelayMs < 0) {
    throw new Error('visibilityDelayMs must be a non-negative integer');
  }
  const endpointIndexes = options.endpointIndex === undefined
    ? CHIPNET_ENDPOINTS.map((_endpoint, index) => index)
    : [options.endpointIndex];
  let attempts = 0;
  for (const index of endpointIndexes) {
    const endpoint = CHIPNET_ENDPOINTS[index];
    if (!endpoint) continue;
    attempts++;
    let broadcastAcknowledged = false;
    try {
      const result = await withElectrum(index, async (client) => {
        const response = await client.request('blockchain.transaction.broadcast', raw);
        if (response instanceof Error) return { accepted: false, visible: false, visibilityChecks: 0, error: safeError(response) };
        if (typeof response !== 'string' || !/^[0-9a-f]{64}$/i.test(response)) {
          return { accepted: false, visible: false, visibilityChecks: 0, error: 'unexpected broadcast response' };
        }
        if (response.toLowerCase() !== txid) {
          return { accepted: false, visible: false, visibilityChecks: 0, error: 'mismatched transaction ID' };
        }
        broadcastAcknowledged = true;

        for (let check = 1; check <= visibilityAttempts; check++) {
          let observed: Awaited<ReturnType<typeof client.request>>;
          try {
            observed = await client.request('blockchain.transaction.get', txid);
          } catch {
            observed = new Error('transaction visibility query failed');
          }
          if (typeof observed === 'string' && /^[0-9a-f]+$/i.test(observed)) {
            return { accepted: true, visible: true, visibilityChecks: check };
          }
          if (check < visibilityAttempts && visibilityDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, visibilityDelayMs));
          }
        }
        return {
          accepted: true,
          visible: false,
          visibilityChecks: visibilityAttempts,
          error: `broadcast acknowledged but transaction was not visible after ${visibilityAttempts} checks`,
        };
      });
      if (!result.accepted) {
        errors.push(`${endpoint.name}: ${result.error ?? 'broadcast rejected'}`);
        continue;
      }
      if (!result.visible) {
        errors.push(`${endpoint.name}: ${result.error ?? 'transaction visibility check failed'}`);
      }
      return {
        accepted: true,
        visible: result.visible,
        endpointAttempts: attempts,
        retries: attempts - 1,
        firstEndpointSuccess: attempts === 1,
        endpointIndex: index,
        visibilityChecks: result.visibilityChecks,
        ...(result.error ? { error: `${endpoint.name}: ${result.error}` } : {}),
      };
    } catch (error) {
      if (broadcastAcknowledged) {
        return {
          accepted: true,
          visible: false,
          endpointAttempts: attempts,
          retries: attempts - 1,
          firstEndpointSuccess: attempts === 1,
          endpointIndex: index,
          visibilityChecks: 0,
          error: `${endpoint.name}: broadcast acknowledged but post-broadcast visibility failed: ${safeError(error)}`,
        };
      }
      errors.push(`${endpoint.name}: ${safeError(error)}`);
    }
  }
  return {
    accepted: false,
    visible: false,
    endpointAttempts: attempts,
    retries: Math.max(0, attempts - 1),
    firstEndpointSuccess: false,
    visibilityChecks: 0,
    error: errors.join(' | '),
  };
}
