import { expect, it } from 'vitest';
import { assertLoadReadResponse } from '../../scripts/acceptance-response';

const actor = { id: 'synthetic-participant', csrf: 'synthetic-csrf' };
const loadedAt = '2026-10-18T12:00:00.000Z';
const page = () => ({ items: [], nextCursor: null });
const market = () => ({
  loadedAt, trading: { status: 'open', executable: true, book: [], trades: [], nextCursor: null }, resolution: null,
  account: { ownerId: actor.id, csrf: actor.csrf, portfolio: { status: 'open', availableCredits: '1000000', reservedCredits: '0',
    holdings: [], openOrders: [], orders: [], fills: [], nextCursor: null, nextFillCursor: null } },
});
const portfolio = () => ({
  loadedAt, csrf: actor.csrf, member: { id: actor.id, handle: 'synthetic_participant' },
  availableCredits: '1000000', reservedCredits: '0', orderReservedCredits: '0', withdrawalReservedCredits: '0',
  holdings: page(), openOrders: [], orders: page(), fills: page(), activity: page(), payouts: page(),
});
const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, private' };
const response = (value: unknown) => new Response(JSON.stringify(value), { headers });

for (const kind of ['market', 'portfolio'] as const) {
  const fixture = kind === 'market' ? market : portfolio;
  it(`accepts a usable private ${kind} snapshot`, async () => {
    await expect(assertLoadReadResponse(response(fixture()), kind, actor)).resolves.toBeUndefined();
  });
  it(`rejects an empty HTTP 200 ${kind} response`, async () => {
    await expect(assertLoadReadResponse(response({}), kind, actor)).rejects.toThrow();
  });
  it(`rejects another participant's ${kind} snapshot`, async () => {
    await expect(assertLoadReadResponse(response(fixture()), kind, { ...actor, id: 'other-participant' })).rejects.toThrow();
  });
  it(`rejects a ${kind} snapshot from another session`, async () => {
    await expect(assertLoadReadResponse(response(fixture()), kind, { ...actor, csrf: 'other-session' })).rejects.toThrow();
  });
  it(`rejects a truncated ${kind} snapshot`, async () => {
    await expect(assertLoadReadResponse(response({ ...fixture(), loadedAt: undefined }), kind, actor)).rejects.toThrow();
  });
}

it('rejects an anonymous market response even though public browsing is available', async () => {
  await expect(assertLoadReadResponse(response({ ...market(), account: null }), 'market', actor)).rejects.toThrow();
});

it('rejects malformed JSON and an HTML sign-in page with HTTP 200', async () => {
  for (const body of ['{', '<html>Sign in</html>']) {
    await expect(assertLoadReadResponse(new Response(body, { headers }), 'portfolio', actor)).rejects.toThrow();
  }
});

it('rejects cacheable, non-JSON, redirected and unsuccessful read responses', async () => {
  const redirected = response(portfolio());
  Object.defineProperty(redirected, 'redirected', { value: true });
  for (const invalid of [
    new Response(JSON.stringify(portfolio()), { headers: { ...headers, 'Cache-Control': 'public, max-age=60' } }),
    new Response(JSON.stringify(portfolio()), { headers: { ...headers, 'Content-Type': 'text/html' } }),
    new Response(JSON.stringify(portfolio()), { status: 503, headers }),
    redirected,
  ]) {
    await expect(assertLoadReadResponse(invalid, 'portfolio', actor)).rejects.toThrow();
  }
});
