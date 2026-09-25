import {
  CAULDRON_DEFAULT_TOKEN_LIMIT,
  CHIPNET_CAULDRON_INDEXER_BASE_URL,
} from './config.js';

const HEX_PATTERN = /^[0-9a-f]+$/i;

export type CauldronTokenSummary = {
  tokenId: string;
  displayName: string | null;
  displaySymbol: string | null;
  scoreRank: number | null;
  tvlSats: bigint | null;
  tvlTokens: bigint | null;
};

export type CauldronActivePool = {
  ownerPkh: string;
  ownerAddress: string | null;
  poolId: string;
  tokenId: string;
  sats: bigint;
  tokens: bigint;
  txid: string;
  txPos: number;
};

export type CauldronMarket = {
  token: CauldronTokenSummary;
  pools: CauldronActivePool[];
};

function normalizeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(normalized)) {
    throw new Error('Cauldron indexer URL must use HTTPS');
  }
  return normalized;
}

function requireHex(value: unknown, length: number, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Cauldron ${label} must be a hex string`);
  }
  const normalized = value.trim().toLowerCase();
  if (normalized.length !== length || !HEX_PATTERN.test(normalized)) {
    throw new Error(`Cauldron ${label} must be ${length} hex characters`);
  }
  return normalized;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requirePositiveBigInt(value: unknown, label: string): bigint {
  const parsed =
    typeof value === 'bigint'
      ? value
      : typeof value === 'number'
        ? Number.isSafeInteger(value)
          ? BigInt(value)
          : null
        : typeof value === 'string' && /^\d+$/.test(value.trim())
          ? BigInt(value.trim())
          : null;
  if (parsed === null || parsed <= 0n) {
    throw new Error(`Cauldron ${label} must be a positive integer`);
  }
  return parsed;
}

function optionalPositiveBigInt(value: unknown): bigint | null {
  if (value === null || value === undefined) return null;
  try {
    return requirePositiveBigInt(value, 'summary value');
  } catch {
    return null;
  }
}

function optionalRank(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    throw new Error(
      `Cauldron indexer request failed with HTTP ${response.status}${
        text ? `: ${text.slice(0, 160)}` : ''
      }`,
    );
  }
  if (!text.trim()) throw new Error('Cauldron indexer returned an empty response');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('Cauldron indexer returned non-JSON content');
  }
}

function extractArray(payload: unknown, key: string): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    const value = (payload as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value;
  }
  throw new Error(`Unexpected Cauldron indexer response shape: expected ${key}`);
}

function normalizeToken(row: unknown): CauldronTokenSummary {
  if (!row || typeof row !== 'object') {
    throw new Error('Cauldron indexer returned an invalid token row');
  }
  const value = row as Record<string, unknown>;
  return {
    tokenId: requireHex(value.token_id, 64, 'token id'),
    displayName: optionalString(value.display_name),
    displaySymbol: optionalString(value.display_symbol),
    scoreRank: optionalRank(value.score_rank),
    tvlSats: optionalPositiveBigInt(value.tvl_sats),
    tvlTokens: optionalPositiveBigInt(value.tvl_tokens),
  };
}

function normalizePool(row: unknown): CauldronActivePool {
  if (!row || typeof row !== 'object') {
    throw new Error('Cauldron indexer returned an invalid pool row');
  }
  const value = row as Record<string, unknown>;
  const txPos = value.tx_pos;
  if (typeof txPos !== 'number' || !Number.isSafeInteger(txPos) || txPos < 0) {
    throw new Error('Cauldron pool tx_pos must be a non-negative integer');
  }
  return {
    ownerPkh: requireHex(value.owner_pkh, 40, 'owner public-key hash'),
    ownerAddress: optionalString(value.owner_p2pkh_addr),
    poolId: requireHex(value.pool_id, 64, 'pool id'),
    tokenId: requireHex(value.token_id, 64, 'pool token id'),
    sats: requirePositiveBigInt(value.sats, 'pool satoshi reserve'),
    tokens: requirePositiveBigInt(value.tokens, 'pool token reserve'),
    txid: requireHex(value.txid, 64, 'pool transaction id'),
    txPos,
  };
}

export class CauldronIndexerClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;

  constructor(
    baseUrl = CHIPNET_CAULDRON_INDEXER_BASE_URL,
    timeoutMs = 15_000,
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error('Cauldron indexer timeout must be a positive integer');
    }
    this.timeoutMs = timeoutMs;
  }

  async listCachedTokens(
    limit = CAULDRON_DEFAULT_TOKEN_LIMIT,
  ): Promise<CauldronTokenSummary[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 500) {
      throw new Error('Cauldron token limit must be between 1 and 500');
    }
    const params = new URLSearchParams({
      limit: String(limit),
      offset: '0',
      by: 'score',
      order: 'desc',
    });
    const payload = await fetchJson(
      `${this.baseUrl}/tokens/list_cached?${params.toString()}`,
      this.timeoutMs,
    );
    return extractArray(payload, 'tokens').map(normalizeToken);
  }

  async listActivePools(tokenId: string): Promise<CauldronActivePool[]> {
    const normalizedTokenId = requireHex(tokenId, 64, 'token id');
    const payload = await fetchJson(
      `${this.baseUrl}/pool/active?token=${encodeURIComponent(normalizedTokenId)}`,
      this.timeoutMs,
    );
    return extractArray(payload, 'active').map(normalizePool);
  }

  async discoverMarket(limit = CAULDRON_DEFAULT_TOKEN_LIMIT): Promise<CauldronMarket> {
    const tokens = await this.listCachedTokens(limit);
    for (const token of tokens) {
      const pools = await this.listActivePools(token.tokenId);
      if (pools.length > 0) return { token, pools };
    }
    throw new Error('No active Cauldron pools found in the configured token set');
  }
}
