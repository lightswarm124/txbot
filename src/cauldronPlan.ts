import type { CauldronActivePool } from './cauldronIndexer.js';

export type CauldronBchToTokenPlan = {
  direction: 'bch-to-token';
  poolId: string;
  poolTxid: string;
  poolOutputIndex: number;
  tokenId: string;
  supplySats: bigint;
  tradeFeeSats: bigint;
  demandTokens: bigint;
  poolInputSats: bigint;
  poolInputTokens: bigint;
  expectedPoolOutputSats: bigint;
  expectedPoolOutputTokens: bigint;
};

function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error('Cauldron division denominator must be positive');
  return (a + b - 1n) / b;
}

function cauldronFee(supplySats: bigint): bigint {
  return (supplySats * 3n) / 1000n;
}

export function planBchToTokenTrade(
  pool: CauldronActivePool,
  supplySats: bigint,
): CauldronBchToTokenPlan {
  if (supplySats <= 0n) throw new Error('Cauldron supply must be positive');
  if (pool.sats <= 693n || pool.tokens <= 1n) {
    throw new Error('Cauldron pool does not have enough reserve for a trade');
  }

  const tradeFeeSats = cauldronFee(supplySats);
  const effectiveSupply = supplySats - tradeFeeSats;
  if (effectiveSupply <= 0n) {
    throw new Error('Cauldron supply is too small after the trade fee');
  }

  const invariant = pool.sats * pool.tokens;
  const expectedPoolOutputSats = pool.sats + supplySats;
  const expectedPoolOutputTokens = ceilDiv(
    invariant,
    pool.sats + effectiveSupply,
  );
  const demandTokens = pool.tokens - expectedPoolOutputTokens;

  if (demandTokens <= 0n) {
    throw new Error('Cauldron quote produces no token demand');
  }
  if (expectedPoolOutputTokens < 1n) {
    throw new Error('Cauldron quote violates the token reserve floor');
  }
  if ((expectedPoolOutputSats - tradeFeeSats) * expectedPoolOutputTokens < invariant) {
    throw new Error('Cauldron quote violates the fee-adjusted invariant');
  }

  return {
    direction: 'bch-to-token',
    poolId: pool.poolId,
    poolTxid: pool.txid,
    poolOutputIndex: pool.txPos,
    tokenId: pool.tokenId,
    supplySats,
    tradeFeeSats,
    demandTokens,
    poolInputSats: pool.sats,
    poolInputTokens: pool.tokens,
    expectedPoolOutputSats,
    expectedPoolOutputTokens,
  };
}
