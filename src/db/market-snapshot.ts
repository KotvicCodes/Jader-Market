import { publicTradingSnapshot, tradingSnapshot } from "./trading";
import { publicResolution } from "./settlement";
import { memberDatabase } from "./members";

export async function marketSnapshot(marketId: string, member?: { token: string; csrf: string; user: { id: string } }) {
  return memberDatabase().db.transaction(async tx => {
    const trading = await publicTradingSnapshot(marketId, undefined, tx);
    const resolution = await publicResolution(marketId, tx);
    const portfolio = member ? await tradingSnapshot(member.token, marketId, undefined, undefined, tx) : null;
    return { loadedAt: new Date().toISOString(), trading, resolution: resolution ? { ...resolution, createdAt: resolution.createdAt.toISOString() } : null,
      account: member && portfolio ? { ownerId: member.user.id, csrf: member.csrf, portfolio } : null };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
export type MarketSnapshot = Awaited<ReturnType<typeof marketSnapshot>>;
