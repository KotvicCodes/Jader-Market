const categories = ["all", "technology", "science", "community"] as const;
export type MarketCategory = typeof categories[number];

export function parseMarketQuery(input: { q?: string; category?: string; page?: string }) {
  const page = Number(input.page ?? "1");
  return {
    query: (input.q ?? "").trim().slice(0, 120),
    category: categories.includes(input.category as MarketCategory) ? input.category as MarketCategory : "all",
    page: Number.isSafeInteger(page) && page > 0 && page <= 10000 ? page : 1,
    pageSize: 12,
  };
}
