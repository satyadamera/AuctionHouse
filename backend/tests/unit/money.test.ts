import { describe, expect, it } from 'vitest';
import { formatMoney, minimumNextBid, parseAmount } from '../../src/utils/money.js';

describe('minimumNextBid', () => {
  it('lets the first bid equal the starting price', () => {
    expect(minimumNextBid('10000.00', null, '100.00').toFixed(2)).toBe('10000.00');
  });
  it('requires current highest + increment afterwards', () => {
    expect(minimumNextBid('10000.00', '10500.00', '250.00').toFixed(2)).toBe('10750.00');
  });
  it('is exact with values that break binary floating point', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in JS numbers; decimal maths must give 0.30
    expect(minimumNextBid('0.10', '0.10', '0.20').toFixed(2)).toBe('0.30');
    expect(0.1 + 0.2).not.toBe(0.3);
  });
});

describe('parseAmount', () => {
  it.each(['1', '10500', '10500.5', '10500.50', '99999999.99'])('accepts %s', (v) => {
    expect(parseAmount(v).ok).toBe(true);
  });
  it.each([
    ['0', 'zero'],
    ['0.00', 'zero with decimals'],
    ['-5', 'negative'],
    ['10.123', 'three decimals'],
    ['1e5', 'scientific notation'],
    ['abc', 'not a number'],
    ['', 'empty'],
    ['100000000.01', 'above the maximum'],
    [' 100', 'leading space'],
  ])('rejects %s (%s)', (v) => {
    expect(parseAmount(v).ok).toBe(false);
  });
  it('normalises to two decimals', () => {
    expect(formatMoney('10500.5')).toBe('10500.50');
  });
});
