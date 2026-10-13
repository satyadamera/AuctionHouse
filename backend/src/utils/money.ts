import { Decimal } from 'decimal.js';

/**
 * Money handling. MySQL returns DECIMAL columns as strings (mysql2 default), and we keep them as
 * strings on the wire too. Arithmetic goes through decimal.js — never JavaScript `number`, because
 * 0.1 + 0.2 !== 0.3 in binary floating point.
 */
export const CURRENCY = 'INR';
export const MONEY_SCALE = 2;
/** DECIMAL(12,2) can hold up to 9,999,999,999.99. We cap well below to keep inputs sane. */
export const MAX_AMOUNT = new Decimal('100000000.00'); // ₹10 crore

export type MoneyString = string;

export function toDecimal(v: Decimal.Value): Decimal {
  return new Decimal(v);
}

/** Normalised 2-dp string, e.g. "10500.00". */
export function formatMoney(v: Decimal.Value): MoneyString {
  return new Decimal(v).toFixed(MONEY_SCALE);
}

/**
 * Minimum acceptable next bid. First bid may equal the starting price; every later bid must be at
 * least current highest + increment.
 */
export function minimumNextBid(
  startingPrice: Decimal.Value,
  currentHighest: Decimal.Value | null,
  increment: Decimal.Value,
): Decimal {
  if (currentHighest === null) return new Decimal(startingPrice);
  return new Decimal(currentHighest).plus(increment);
}

/** Validates a client-supplied amount string: positive, ≤ 2 decimal places, within range. */
export function parseAmount(input: string): { ok: true; value: Decimal } | { ok: false; reason: string } {
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(input)) {
    return { ok: false, reason: 'Amount must be a positive number with at most 2 decimal places' };
  }
  const value = new Decimal(input);
  if (value.lte(0)) return { ok: false, reason: 'Amount must be greater than zero' };
  if (value.gt(MAX_AMOUNT)) return { ok: false, reason: `Amount must not exceed ${MAX_AMOUNT.toFixed(2)}` };
  return { ok: true, value };
}
