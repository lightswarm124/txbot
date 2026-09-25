import { describe, expect, it } from 'vitest';

import { planBchToTokenTrade } from '../src/cauldronPlan.js';

const pool = {
  ownerPkh: 'a'.repeat(40),
  ownerAddress: null,
  poolId: 'b'.repeat(64),
  tokenId: 'c'.repeat(64),
  sats: 118_789_888n,
  tokens: 37_627n,
  txid: 'd'.repeat(64),
  txPos: 0,
};

describe('Cauldron dry-run planning', () => {
  it('plans a BCH-to-token quote with reserve and fee checks', () => {
    const plan = planBchToTokenTrade(pool, 10_000n);

    expect(plan.tradeFeeSats).toBe(30n);
    expect(plan.demandTokens).toBeGreaterThan(0n);
    expect(plan.expectedPoolOutputSats).toBe(118_799_888n);
  });

  it('rejects pools that cannot preserve the reserve floor', () => {
    expect(() =>
      planBchToTokenTrade({ ...pool, tokens: 1n }, 10_000n),
    ).toThrow(/reserve/);
  });
});
