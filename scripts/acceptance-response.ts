import { readMarketSnapshot, readPortfolioSnapshot } from '../src/components/snapshot-data';
import { tradingResult, type TradingRequest } from '../src/domain/trading-ticket';

async function readLoadResponse(response: Response): Promise<unknown> {
  const value: unknown = await response.json();
  if (response.status !== 200 || response.redirected ||
      response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json' ||
      !response.headers.get('cache-control')?.split(',').some(value => value.trim().toLowerCase() === 'no-store')) {
    throw new Error('invalid_load_response');
  }
  return value;
}

/** A fast HTTP 200 is useful load evidence only if the participant can use it. */
export async function assertLoadReadResponse(response: Response, kind: 'market' | 'portfolio', actor: { id: string; csrf: string }) {
  const value = await readLoadResponse(response);
  // Use the same complete shape and account checks as the visible application.
  const csrf = kind === 'market'
    ? readMarketSnapshot(value, actor.id).account?.csrf
    : readPortfolioSnapshot(value, actor.id).csrf;
  if (csrf !== actor.csrf) throw new Error('invalid_load_read_session');
}

/** Persisted accounting alone cannot confirm that a client received its result. */
export async function assertLoadWriteResponse(response: Response, request: TradingRequest) {
  const value = await readLoadResponse(response);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_load_write_response');
  // Use the same request/reference validation as the visible trading controls.
  tradingResult(request, value as Record<string, unknown>);
}
