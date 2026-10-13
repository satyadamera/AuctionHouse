/**
 * Exact money arithmetic in integer paise (BigInt). Used only for UI conveniences such as the
 * quick-add buttons; the server re-validates every amount and computes the real minimum itself.
 */
export function toPaise(amount: string): bigint {
  const [rupees = '0', paise = ''] = amount.trim().split('.');
  return BigInt(rupees) * 100n + BigInt((paise + '00').slice(0, 2));
}

export function fromPaise(p: bigint): string {
  const neg = p < 0n;
  const abs = neg ? -p : p;
  return `${neg ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

export const isValidAmount = (s: string) => /^\d{1,12}(\.\d{1,2})?$/.test(s.trim()) && toPaise(s) > 0n;

export const addIncrements = (base: string, increment: string, times: number) => fromPaise(toPaise(base) + toPaise(increment) * BigInt(times));

export const gte = (a: string, b: string) => toPaise(a) >= toPaise(b);
