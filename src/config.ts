export type ElectrumTransport = 'tls' | 'wss';

export type ElectrumEndpoint = {
  name: string;
  host: string;
  port: number;
  transport: ElectrumTransport;
  priority: number;
};

export const CHIPNET_ENDPOINTS: readonly ElectrumEndpoint[] = [
  {
    name: 'bch-ninja',
    host: 'chipnet.bch.ninja',
    port: 50002,
    transport: 'tls',
    priority: 10,
  },
  {
    name: 'imaginary-cash',
    host: 'chipnet.imaginary.cash',
    port: 50002,
    transport: 'tls',
    priority: 20,
  },
  {
    name: 'optnlabs',
    host: 'electrum-chipnet.optnlabs.com',
    port: 50004,
    transport: 'wss',
    priority: 30,
  },
];

export const CHIPNET_BIP44 = {
  purpose: 44,
  coinType: 1,
  account: 0,
  change: 0,
} as const;

export const FEE_RATE_SATS_PER_BYTE = 1n;

export const CHIPNET_CAULDRON_INDEXER_BASE_URL =
  process.env.CAULDRON_CHIPNET_INDEXER_URL?.trim() ||
  'https://indexer-chipnet.riften.net/cauldron';

export const CAULDRON_PUSD_TOKEN_ID =
  'dfe50223c8d5cba8dcef8dff6d92b61deb88a8ba44947367f2b746487b56039b';
export const CAULDRON_DEFAULT_TOKEN_LIMIT = 5;
export const CAULDRON_DEFAULT_SUPPLY_SATS = 10_000n;
