import { expect, it } from 'vitest';
import { assertLoadReadResponse, assertLoadWriteResponse } from '../../scripts/acceptance-response';
import type { TradingRequest } from '../../src/domain/trading-ticket';

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

const mint = { action: 'mint', body: { marketId: 'synthetic-market', operationKey: 'synthetic-operation', quantity: '1' } } as const;
const place = { action: 'place', body: { ...mint.body, price: '2500', outcome: 'YES', side: 'buy', timeInForce: 'IOC' } } as const;
const mintResult = () => ({ operationKey: mint.body.operationKey, action: 'mint', quantity: '1' });
const orderResult = () => ({ order: { id: place.body.operationKey, quantity: '1', remaining: '0', status: 'filled' }, fills: [] });

for (const [request, fixture] of [[mint, mintResult], [place, orderResult]] as const) {
  it(`accepts a usable ${request.action} result bound to the submitted request`, async () => {
    await expect(assertLoadWriteResponse(response(fixture()), request)).resolves.toBeUndefined();
  });

  it(`rejects empty, malformed and non-object HTTP 200 ${request.action} results`, async () => {
    for (const body of ['{}', 'null', '[]', '"saved"', '{', '<html>Sign in</html>']) {
      await expect(assertLoadWriteResponse(new Response(body, { headers }), request)).rejects.toThrow();
    }
  });

  it(`rejects a ${request.action} result belonging to another operation`, async () => {
    const value = request.action === 'mint'
      ? { ...mintResult(), operationKey: 'another-operation' }
      : { order: { ...orderResult().order, id: 'another-order' } };
    await expect(assertLoadWriteResponse(response(value), request)).rejects.toThrow();
  });
}

it('rejects mint acknowledgements with the wrong action or quantity', async () => {
  for (const value of [{ ...mintResult(), action: 'burn' }, { ...mintResult(), quantity: '2' }]) {
    await expect(assertLoadWriteResponse(response(value), mint)).rejects.toThrow();
  }
});

it('rejects unusable order state and share quantities', async () => {
  for (const changes of [{ status: 'unknown' }, { quantity: '0' }, { remaining: '-1' }, { remaining: '2' }]) {
    await expect(assertLoadWriteResponse(response({ order: { ...orderResult().order, ...changes } }), place)).rejects.toThrow();
  }
});

it('rejects redirected, cacheable, non-JSON and unsuccessful write responses', async () => {
  const redirected = response(mintResult());
  Object.defineProperty(redirected, 'redirected', { value: true });
  for (const invalid of [
    new Response(JSON.stringify(mintResult()), { headers: { ...headers, 'Cache-Control': 'public, max-age=60' } }),
    new Response(JSON.stringify(mintResult()), { headers: { ...headers, 'Content-Type': 'text/html' } }),
    new Response(JSON.stringify(mintResult()), { status: 201, headers }),
    new Response(JSON.stringify(mintResult()), { status: 503, headers }),
    redirected,
  ]) {
    await expect(assertLoadWriteResponse(invalid, mint)).rejects.toThrow();
  }
});

it('also preserves the UI result contract for burn and cancellation requests', async () => {
  const burn: TradingRequest = { ...mint, action: 'burn' };
  await expect(assertLoadWriteResponse(response({ ...mintResult(), action: 'burn' }), burn)).resolves.toBeUndefined();
  const cancel: TradingRequest = { action: 'cancel', body: { marketId: mint.body.marketId, operationKey: 'cancel-operation', orderId: place.body.operationKey } };
  await expect(assertLoadWriteResponse(response(orderResult()), cancel)).resolves.toBeUndefined();
});
