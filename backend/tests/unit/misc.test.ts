import { describe, expect, it } from 'vitest';
import { plainText } from '../../src/utils/sanitize.js';
import { publicName } from '../../src/modules/auctions/auction.repository.js';
import { createAuctionSchema, placeBidSchema } from '../../src/modules/auctions/auction.schemas.js';
import { CacheKeys } from '../../src/cache/keys.js';

describe('plainText (stored XSS defence)', () => {
  it('strips tags', () => {
    expect(plainText('<script>alert(1)</script>Nice watch')).toBe('alert(1)Nice watch');
    expect(plainText('<img src=x onerror=alert(1)>Lot')).toBe('Lot');
  });
  it('keeps ordinary punctuation', () => {
    expect(plainText('5 < 6 and “quotes” — fine')).toBe('5 < 6 and “quotes” — fine');
  });
});

describe('publicName', () => {
  it('shortens surnames', () => expect(publicName('Aarav Mehta')).toBe('Aarav M.'));
  it('handles single names', () => expect(publicName('Cher')).toBe('Cher'));
});

describe('request schemas', () => {
  it('rejects money with excessive precision', () => {
    const r = createAuctionSchema.safeParse({
      title: 'A watch', description: 'A lovely watch indeed', categoryId: 1, startingPrice: '10.555', minimumBidIncrement: '1',
      startTime: new Date().toISOString(), endTime: new Date(Date.now() + 3600e3).toISOString(),
    });
    expect(r.success).toBe(false);
  });
  it('requires a well-formed idempotency key', () => {
    expect(placeBidSchema.safeParse({ amount: '100', clientRequestId: 'short' }).success).toBe(false);
    expect(placeBidSchema.safeParse({ amount: '100', clientRequestId: '3f1c2a8e-6c7b-4f0e-9d1a-0b6f0c5e9a11' }).success).toBe(true);
    expect(placeBidSchema.safeParse({ amount: '100', clientRequestId: 'drop table;--xx' }).success).toBe(false);
  });
});

describe('cache key namespace', () => {
  it('is versioned and entity-scoped', () => {
    expect(CacheKeys.auctionDetail(42)).toBe('auctra:v1:auction:detail:42');
    expect(CacheKeys.browse(3, 'abc')).toBe('auctra:v1:auctions:list:3:abc');
  });
});
