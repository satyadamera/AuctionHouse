import { describe, expect, it } from 'vitest';
import { addIncrements, fromPaise, gte, isValidAmount, toPaise } from './money';
import { formatINR, formatRemaining, lotNumber } from './format';

describe('money (exact paise arithmetic)', () => {
  it('round-trips amounts', () => {
    expect(fromPaise(toPaise('10500.5'))).toBe('10500.50');
    expect(fromPaise(toPaise('0.07'))).toBe('0.07');
  });
  it('adds increments without float error', () => {
    expect(addIncrements('0.10', '0.20', 1)).toBe('0.30');
    expect(addIncrements('10000.00', '500.00', 3)).toBe('11500.00');
  });
  it('validates and compares', () => {
    expect(isValidAmount('100.5')).toBe(true);
    expect(isValidAmount('100.555')).toBe(false);
    expect(isValidAmount('0')).toBe(false);
    expect(gte('100.00', '100')).toBe(true);
    expect(gte('99.99', '100')).toBe(false);
  });
});

describe('formatting', () => {
  it('formats rupees with Indian digit grouping', () => {
    expect(formatINR('114000.00')).toBe('₹1,14,000');
    expect(formatINR('10500.50')).toBe('₹10,500.50');
    expect(formatINR(null)).toBe('—');
  });
  it('formats remaining time coarsely far away and precisely near the end', () => {
    expect(formatRemaining(2 * 86_400_000 + 4 * 3_600_000)).toBe('2d 4h');
    expect(formatRemaining(4 * 60_000 + 9_000)).toBe('4m 09s');
    expect(formatRemaining(42_000)).toBe('42s');
    expect(formatRemaining(-5)).toBe('0s');
  });
  it('pads lot numbers', () => expect(lotNumber(7)).toBe('Lot 007'));
});
