/**
 * Proves the retry wrapper against a REAL InnoDB deadlock, not a mocked error code.
 * T1 locks auction X then Y; T2 locks Y then X. InnoDB detects the cycle and rolls one back with
 * errno 1213; withTransactionRetry replays it from scratch and both transactions end up committed.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, type DB } from '../../src/database/db.js';
import { closeRedis } from '../../src/cache/redis.js';
import { withTransactionRetry } from '../../src/modules/bids/bid.service.js';
import { lockAuction } from '../../src/modules/auctions/auction.repository.js';
import { AppError } from '../../src/utils/errors.js';
import { createAuction, createUser, getAuctionRow, resetState } from '../helpers/fixtures.js';

beforeEach(async () => resetState());
afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe('deadlock handling', () => {
  it('recovers from a real deadlock by retrying the victim transaction', async () => {
    const s = await createUser('SELLER');
    const x = await createAuction({ sellerId: s.id });
    const y = await createAuction({ sellerId: s.id });
    let attempts = 0;
    let bothHoldFirstLock!: () => void;
    let holders = 0;
    const barrier = new Promise<void>((r) => (bothHoldFirstLock = r));

    const crossLock = (first: number, second: number) =>
      withTransactionRetry(getDb(), 'deadlock-test', async (trx: DB) => {
        attempts++;
        await lockAuction(trx, first);
        if (++holders === 2) bothHoldFirstLock();
        // First attempt: wait until both transactions hold their first lock → guaranteed cycle.
        if (attempts <= 2) await Promise.race([barrier, new Promise((r) => setTimeout(r, 1000))]);
        await lockAuction(trx, second);
        await trx.updateTable('auctions').set({ title: `touched ${first}->${second}` }).where('id', '=', first).execute();
        return true;
      });

    const results = await Promise.all([crossLock(x, y), crossLock(y, x)]);
    expect(results).toEqual([true, true]);
    expect(attempts).toBeGreaterThanOrEqual(3); // at least one transaction was retried
    expect((await getAuctionRow(x)).title).toBe(`touched ${x}->${y}`);
    expect((await getAuctionRow(y)).title).toBe(`touched ${y}->${x}`);
  });

  it('gives up after a bounded number of attempts with a retryable 503 error', async () => {
    let calls = 0;
    const err = Object.assign(new Error('Deadlock found'), { errno: 1213 });
    await expect(
      withTransactionRetry(getDb(), 'always-deadlocks', async () => {
        calls++;
        throw err;
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.code === 'CONFLICT_RETRY_EXHAUSTED' && e.status === 503);
    expect(calls).toBe(3);
  });

  it('does not retry non-retryable errors', async () => {
    let calls = 0;
    await expect(
      withTransactionRetry(getDb(), 'business-error', async () => {
        calls++;
        throw new AppError('BID_TOO_LOW', 'too low');
      }),
    ).rejects.toBeInstanceOf(AppError);
    expect(calls).toBe(1);
  });
});
