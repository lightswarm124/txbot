import {
  CAULDRON_PUSD_TOKEN_ID,
  CAULDRON_DEFAULT_SUPPLY_SATS,
  CAULDRON_DEFAULT_TOKEN_LIMIT,
} from './config.js';
import { CauldronIndexerClient } from './cauldronIndexer.js';
import { planBchToTokenTrade } from './cauldronPlan.js';

function readPositiveBigInt(name: string, fallback: bigint): bigint {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = BigInt(raw);
  if (value <= 0n) throw new Error(`${name} must be a positive integer`);
  return value;
}

async function main(): Promise<void> {
  const tokenLimit = Number(
    process.env.CAULDRON_TOKEN_LIMIT ?? CAULDRON_DEFAULT_TOKEN_LIMIT,
  );
  const supplySats = readPositiveBigInt(
    'CAULDRON_SUPPLY_SATS',
    CAULDRON_DEFAULT_SUPPLY_SATS,
  );
  const configuredTokenId =
    process.env.CAULDRON_TOKEN_ID?.trim().toLowerCase() ||
    CAULDRON_PUSD_TOKEN_ID;
  const indexer = new CauldronIndexerClient();
  const market = configuredTokenId
    ? {
        token: (await indexer.listCachedTokens(tokenLimit)).find(
          (token) => token.tokenId === configuredTokenId,
        ),
        pools: await indexer.listActivePools(configuredTokenId),
      }
    : await indexer.discoverMarket(tokenLimit);

  if (!market.token || market.pools.length === 0) {
    throw new Error('Configured Cauldron token has no active indexed pools');
  }

  const pool = [...market.pools].sort((left, right) => {
    if (left.sats === right.sats) return left.tokens > right.tokens ? -1 : 1;
    return left.sats > right.sats ? -1 : 1;
  })[0];
  const plan = planBchToTokenTrade(pool, supplySats);

  console.log(
    JSON.stringify({
      mode: 'dry-run',
      network: 'chipnet',
      indexer: indexer.baseUrl,
      tokenId: market.token.tokenId,
      tokenSymbol: market.token.displaySymbol,
      activePoolCount: market.pools.length,
      selectedPoolId: plan.poolId,
      selectedPoolTxid: plan.poolTxid,
      selectedPoolOutputIndex: plan.poolOutputIndex,
      direction: plan.direction,
      supplySats: plan.supplySats.toString(),
      tradeFeeSats: plan.tradeFeeSats.toString(),
      demandTokens: plan.demandTokens.toString(),
      expectedPoolOutputSats: plan.expectedPoolOutputSats.toString(),
      expectedPoolOutputTokens: plan.expectedPoolOutputTokens.toString(),
      signing: false,
      broadcast: false,
    }),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
