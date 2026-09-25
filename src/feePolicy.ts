import { FEE_RATE_SATS_PER_BYTE } from './config.js';

export function feeForSerializedSize(sizeBytes: number): bigint {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new Error('serialized transaction size must be a positive integer');
  }

  return BigInt(sizeBytes) * FEE_RATE_SATS_PER_BYTE;
}

export function assertExactOneSatPerByte(
  sizeBytes: number,
  feeSats: bigint,
): void {
  const expected = feeForSerializedSize(sizeBytes);
  if (feeSats !== expected) {
    throw new Error(
      `fee policy violation: expected ${expected} sats for ${sizeBytes} bytes, got ${feeSats}`,
    );
  }
}
