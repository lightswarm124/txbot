import { createHash } from 'node:crypto';
import { config as loadDotenv } from 'dotenv';
import {
  deriveHdPath,
  deriveHdPrivateNodeFromBip39Mnemonic,
  deriveHdPublicNode,
  hash160,
  hexToBin,
} from '@bitauth/libauth';
import { ExchangeLab } from '@cashlab/cauldron';
import { ElectrumClient } from '@electrum-cash/network';
import { ElectrumTcpSocket } from '@electrum-cash/tcp-socket';
import { ElectrumWebSocket } from '@electrum-cash/web-socket';

import { CAULDRON_PUSD_TOKEN_ID, CHIPNET_ENDPOINTS } from './config.js';
import { CauldronIndexerClient } from './cauldronIndexer.js';

const EXPECTED_NEW_POOLS = 3;
const EXPECTED_NEW_POOLS_BIGINT = BigInt(EXPECTED_NEW_POOLS);
const EXPECTED_RESERVE_SATS = 10_000_000n;
const WAIT_LIMIT_MS = 120_000;
const POLL_INTERVAL_MS = 5_000;

type TokenUtxo = { tx_hash: string; tx_pos: number; value: number | string; token_data?: unknown };

async function listScriptUtxos(scriptHash: string): Promise<TokenUtxo[]> {
  let lastError: unknown;
  for (const endpoint of CHIPNET_ENDPOINTS) {
    const socket = endpoint.transport === 'wss'
      ? new ElectrumWebSocket(endpoint.host, { port: endpoint.port, encrypted: true })
      : new ElectrumTcpSocket(endpoint.host, { port: endpoint.port, encrypted: true });
    const client = new ElectrumClient('CauldronPoolVerifier', '1.4.1', socket);
    try {
      await client.connect();
      const response = await client.request('blockchain.scripthash.listunspent', scriptHash, 'include_tokens');
      if (Array.isArray(response)) return response as TokenUtxo[];
      throw new Error('Electrum returned an invalid pool UTXO list');
    } catch (error) {
      lastError = error;
    } finally {
      await client.disconnect(true).catch(() => undefined);
    }
  }
  throw new Error(`All Chipnet Electrum endpoints failed: ${lastError instanceof Error ? lastError.message : 'unknown error'}`);
}

async function main(): Promise<void> {
  loadDotenv({ path: `${process.cwd()}/.env`, override: false });
  const mnemonic = process.env.OPTN_TXBOT_MNEMONIC?.trim();
  if (!mnemonic) throw new Error('OPTN_TXBOT_MNEMONIC is required in the local environment');
  const master = deriveHdPrivateNodeFromBip39Mnemonic(mnemonic, { passphrase: '' });
  const child = deriveHdPath(master, "m/44'/1'/0'/0/0");
  const ownerPkhBytes = hash160(deriveHdPublicNode(child).publicKey);
  const ownerPkh = Buffer.from(ownerPkhBytes).toString('hex');
  const indexer = new CauldronIndexerClient();
  const lab = new ExchangeLab();
  const poolLockingBytecode = lab.generatePoolV0LockingBytecode({ withdraw_pubkey_hash: ownerPkhBytes });
  const poolScriptHash = createHash('sha256').update(poolLockingBytecode).digest().reverse().toString('hex');
  const deadline = Date.now() + WAIT_LIMIT_MS;
  const once = process.argv.includes('--once');

  while (true) {
    const [pools, poolUtxos] = await Promise.all([
      indexer.listActivePools(CAULDRON_PUSD_TOKEN_ID),
      listScriptUtxos(poolScriptHash),
    ]);
    const mine = pools.filter((pool) => pool.ownerPkh === ownerPkh && pool.tokenId === CAULDRON_PUSD_TOKEN_ID);
    const totalSats = mine.reduce((total, pool) => total + pool.sats, 0n);
    const totalPusdUnits = mine.reduce((total, pool) => total + pool.tokens, 0n);
    const ownedPusdPoolUtxos = poolUtxos.filter((utxo) => {
      if (!utxo.token_data || typeof utxo.token_data !== 'object') return false;
      const token = utxo.token_data as Record<string, unknown>;
      return token.category === CAULDRON_PUSD_TOKEN_ID && typeof token.amount === 'string' && /^\d+$/.test(token.amount);
    });
    const pendingPoolSats = ownedPusdPoolUtxos.reduce((total, utxo) => total + BigInt(utxo.value), 0n);
    if (mine.length >= EXPECTED_NEW_POOLS || ownedPusdPoolUtxos.length >= EXPECTED_NEW_POOLS || once || Date.now() >= deadline) {
      const result = {
        network: 'chipnet',
        tokenId: CAULDRON_PUSD_TOKEN_ID,
        matchingPoolCount: mine.length,
        expectedNewPoolCount: EXPECTED_NEW_POOLS,
        expectedReserveSatsEach: EXPECTED_RESERVE_SATS.toString(),
        totalMatchingSats: totalSats.toString(),
        totalMatchingPusdUnits: totalPusdUnits.toString(),
        electrumUnspentPoolOutputCount: ownedPusdPoolUtxos.length,
        electrumUnspentPoolSats: pendingPoolSats.toString(),
        indexed: mine.length >= EXPECTED_NEW_POOLS && totalSats >= EXPECTED_NEW_POOLS_BIGINT * EXPECTED_RESERVE_SATS,
        pendingOrConfirmedOnElectrum: ownedPusdPoolUtxos.length >= EXPECTED_NEW_POOLS && pendingPoolSats >= EXPECTED_NEW_POOLS_BIGINT * EXPECTED_RESERVE_SATS,
      };
      console.log(JSON.stringify(result));
      process.exitCode = result.indexed || result.pendingOrConfirmedOnElectrum ? 0 : 1;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Cauldron pool verification failed');
  process.exitCode = 1;
});
