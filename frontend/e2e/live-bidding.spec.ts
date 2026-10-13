/**
 * Demo 1, automated: two independent browser sessions (separate cookie jars, like two people)
 * watch the same lot. A bid from one appears on the other's screen without a reload, the outbid
 * user is told, and both converge on the same price and bid history.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';

const PASSWORD = 'Auctra@2026';
const API = process.env.E2E_API_URL ?? 'http://localhost:4000';

async function signIn(browser: Browser, email: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: /Account menu/ })).toBeVisible();
  return page;
}

async function createLiveAuction(): Promise<number> {
  const login = await fetch(`${API}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'meera@auctra.dev', password: PASSWORD }),
  });
  const token = ((await login.json()) as { data: { accessToken: string } }).data.accessToken;
  const res = await fetch(`${API}/api/v1/dev/demo-auction`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ title: `E2E live lot ${Date.now()}`, startingPrice: '10000', minimumBidIncrement: '500', endsInSeconds: 600 }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { id: number } }).data.id;
}

async function placeBid(page: Page, amount: string) {
  const input = page.getByLabel('Your bid');
  await input.fill(amount);
  await page.getByRole('button', { name: 'Place bid' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm your bid' });
  await dialog.getByRole('button', { name: /^Bid / }).click();
  await expect(dialog).toBeHidden();
}

const priceRegion = (page: Page) => page.locator('section[aria-labelledby="bid-panel-title"]');

test('a bid in one session appears live in another, and the outbid bidder is told', async ({ browser }) => {
  const auctionId = await createLiveAuction();
  const alice = await signIn(browser, 'aarav@auctra.dev');
  const bob = await signIn(browser, 'diya@auctra.dev');

  await alice.goto(`/auctions/${auctionId}`);
  await bob.goto(`/auctions/${auctionId}`);
  await expect(priceRegion(alice).getByText('Live', { exact: true }).last()).toBeVisible();
  await expect(priceRegion(bob).getByText('Live', { exact: true }).last()).toBeVisible();

  // Alice bids the starting price; Bob sees it without reloading.
  await placeBid(alice, '10000');
  await expect(priceRegion(alice).getByText('You’re the highest bidder')).toBeVisible();
  await expect(priceRegion(bob).getByText('₹10,000', { exact: true })).toBeVisible();
  await expect(priceRegion(bob).getByText('Leading: Aarav M.')).toBeVisible();

  // Bob outbids; Alice sees the new price and the outbid state, plus a toast.
  await placeBid(bob, '11000');
  await expect(priceRegion(alice).getByText('₹11,000', { exact: true })).toBeVisible();
  await expect(priceRegion(alice).getByText('You’ve been outbid')).toBeVisible();
  await expect(alice.getByText('You have been outbid')).toBeVisible();

  // Both screens agree, and the bid history shows both persisted bids.
  for (const page of [alice, bob]) {
    await expect(priceRegion(page).getByText('₹11,000', { exact: true })).toBeVisible();
    const history = page.locator('section[aria-labelledby="history"] li');
    await expect(history).toHaveCount(2);
  }

  // The REST API (MySQL) agrees with what the browsers show.
  const detail = (await (await fetch(`${API}/api/v1/auctions/${auctionId}`)).json()) as { data: unknown };
  expect(detail.data).toMatchObject({ currentHighestBid: '11000.00', bidCount: 2 });
});

test('a too-low bid is rejected by the server with the live minimum', async ({ browser }) => {
  const auctionId = await createLiveAuction();
  const page = await signIn(browser, 'kabir@auctra.dev');
  await page.goto(`/auctions/${auctionId}`);
  await page.getByLabel('Your bid').fill('9000');
  await page.getByRole('button', { name: 'Place bid' }).click();
  await expect(page.getByText(/Bid at least ₹10,000/)).toBeVisible();
});

test('a regular user cannot reach the seller tools', async ({ browser }) => {
  const page = await signIn(browser, 'rohan@auctra.dev');
  await page.goto('/sell');
  await expect(page.getByRole('heading', { name: 'Seller accounts only' })).toBeVisible();
});
