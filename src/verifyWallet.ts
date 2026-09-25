import { createHash } from 'node:crypto';
import { config as loadDotenv } from 'dotenv';
import {
  deriveHdPath,
  deriveHdPublicNode,
  deriveHdPrivateNodeFromBip39Mnemonic,
  encodeCashAddress,
  hash160,
} from '@bitauth/libauth';
import { ElectrumClient } from '@electrum-cash/network';
import { ElectrumTcpSocket } from '@electrum-cash/tcp-socket';
import { ElectrumWebSocket } from '@electrum-cash/web-socket';

import { CHIPNET_ENDPOINTS } from './config.js';
import { CAULDRON_PUSD_TOKEN_ID } from './config.js';

const EXPECTED_SATS = 500_000_000n;
const DERIVATION_PATH = "m/44'/1'/0'/0/0";

type ListedUtxo = {
  value: number | string;
  token_data?: unknown;
};

type HistoryItem = { height?: unknown };

type ElectrumResponse = {
  result?: unknown;
  error?: unknown;
};

function p2pkhLockingBytecode(publicKey: Uint8Array): Uint8Array {
  const lockingBytecode = new Uint8Array(25);
  lockingBytecode[0] = 0x76;
  lockingBytecode[1] = 0xa9;
  lockingBytecode[2] = 0x14;
  lockingBytecode.set(hash160(publicKey), 3);
  lockingBytecode[23] = 0x88;
  lockingBytecode[24] = 0xac;
  return lockingBytecode;
}

function electrumScriptHash(lockingBytecode: Uint8Array): string {
  return createHash('sha256')
    .update(lockingBytecode)
    .digest()
    .reverse()
    .toString('hex');
}

async function listUnspent(
  host: string,
  port: number,
  transport: 'tls' | 'wss',
  scriptHash: string,
): Promise<ListedUtxo[]> {
  const socket =
    transport === 'wss'
      ? new ElectrumWebSocket(host, { port, encrypted: true })
      : new ElectrumTcpSocket(host, { port, encrypted: true });
  const client = new ElectrumClient(
    'CauldronTxBotWalletCheck',
    '1.4.1',
    socket,
  );

  try {
    await client.connect();
    const result = (await client.request(
      'blockchain.scripthash.listunspent',
      scriptHash,
      'include_tokens',
    )) as unknown;
    if (!Array.isArray(result)) {
      throw new Error('Electrum returned a non-array UTXO result');
    }
    return result as ListedUtxo[];
  } finally {
    await client.disconnect(true).catch(() => undefined);
  }
}

function deriveFirstAddress(mnemonic: string): {
  address: string;
  lockingBytecode: Uint8Array;
} {
  const master = deriveHdPrivateNodeFromBip39Mnemonic(mnemonic, {
    passphrase: '',
  });
  const child = deriveHdPath(master, DERIVATION_PATH);
  const publicKey = deriveHdPublicNode(child).publicKey;
  const address = encodeCashAddress({
    payload: hash160(publicKey),
    prefix: 'bchtest',
    type: 'p2pkh',
    throwErrors: true,
  }).address;

  return {
    address,
    lockingBytecode: p2pkhLockingBytecode(publicKey),
  };
}

async function main(): Promise<void> {
  loadDotenv({ path: `${process.cwd()}/.env`, override: false });
  const mnemonic = process.env.OPTN_TXBOT_MNEMONIC?.trim();
  if (!mnemonic) {
    throw new Error('OPTN_TXBOT_MNEMONIC is required in the local environment');
  }

  const { address, lockingBytecode } = deriveFirstAddress(mnemonic);
  const scriptHash = electrumScriptHash(lockingBytecode);
  let lastError: unknown;

  for (const endpoint of CHIPNET_ENDPOINTS) {
    try {
      const utxos = await listUnspent(
        endpoint.host,
        endpoint.port,
        endpoint.transport,
        scriptHash,
      );
      const historySocket =
        endpoint.transport === 'wss'
          ? new ElectrumWebSocket(endpoint.host, { port: endpoint.port, encrypted: true })
          : new ElectrumTcpSocket(endpoint.host, { port: endpoint.port, encrypted: true });
      const historyClient = new ElectrumClient('CauldronTxBotHistoryCheck', '1.4.1', historySocket);
      let history: HistoryItem[];
      try {
        await historyClient.connect();
        const response = (await historyClient.request(
          'blockchain.scripthash.get_history', scriptHash,
        )) as unknown;
        if (!Array.isArray(response)) throw new Error('Electrum returned invalid address history');
        history = response as HistoryItem[];
      } finally {
        await historyClient.disconnect(true).catch(() => undefined);
      }
      const observedSats = utxos.reduce(
        (total, utxo) => total + BigInt(utxo.value),
        0n,
      );
      const tokenRows = utxos.flatMap((utxo) => {
        if (!utxo.token_data || typeof utxo.token_data !== 'object') return [];
        return [utxo.token_data as Record<string, unknown>];
      });
      const pusdRows = tokenRows.filter((row) =>
        [row.category, row.token_id, row.tokenId].some(
          (value) =>
            typeof value === 'string' &&
            value.toLowerCase() === CAULDRON_PUSD_TOKEN_ID,
        ),
      );

      // Deliberately omit the address, script hash, UTXOs, and endpoint error
      // details from normal output: this check is intended to be safe to share.
      console.log(
        JSON.stringify({
          network: 'chipnet',
          derivationPath: DERIVATION_PATH,
          endpoint: endpoint.name,
          addressDerived: Boolean(address),
          expectedSats: EXPECTED_SATS.toString(),
          observedSats: observedSats.toString(),
          matchesExpectedBalance: observedSats === EXPECTED_SATS,
          utxoCount: utxos.length,
          tokenUtxoCount: tokenRows.length,
          pusdTokenUtxoCount: pusdRows.length,
          historyEntryCount: history.length,
          unconfirmedHistoryCount: history.filter((item) => item.height === 0).length,
          tokenDataFieldNames: [...new Set(tokenRows.flatMap(Object.keys))],
        }),
      );
      process.exitCode = observedSats === EXPECTED_SATS ? 0 : 1;
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `all Chipnet endpoints failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
