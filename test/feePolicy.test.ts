import { describe, expect, it } from 'vitest';

import {
  assertExactOneSatPerByte,
  feeForSerializedSize,
} from '../src/feePolicy.js';

describe('fee policy', () => {
  it('charges exactly one satoshi per serialized byte', () => {
    expect(feeForSerializedSize(192)).toBe(192n);
    expect(() => assertExactOneSatPerByte(192, 192n)).not.toThrow();
  });

  it('rejects any fee other than the exact serialized size', () => {
    expect(() => assertExactOneSatPerByte(192, 193n)).toThrow(
      'fee policy violation',
    );
  });
});
