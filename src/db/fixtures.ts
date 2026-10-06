// Fictional examples only. These are not predictions or live markets.
export const syntheticMarkets = [
  {
    slug: "demo-launch",
    question: "Will the fictional demo launch before its deadline?",
    description: "A synthetic market for testing browsing and resolution rules. No trading is enabled.",
    category: "technology",
    resolutionRules: "In a future test scenario, resolve YES only if the synthetic release record precedes the closing time. Otherwise resolve NO. Missing test evidence makes the market invalid.",
    resolutionSource: "Synthetic release record supplied by the test operator.",
  },
  {
    slug: "demo-observation",
    question: "Will the synthetic observation meet its target?",
    description: "Fictional scientific data will be used to test an objectively defined result.",
    category: "science",
    resolutionRules: "In a future test scenario, resolve YES when the synthetic observation is at least 100 units at the deadline. Otherwise resolve NO. Missing test evidence makes the market invalid.",
    resolutionSource: "Synthetic observation record supplied by the test operator.",
  },
  {
    slug: "demo-community",
    question: "Will the fictional community reach its activity goal?",
    description: "An example community question with an explicit deadline and resolution source.",
    category: "community",
    resolutionRules: "In a future test scenario, resolve YES when the fictional group has completed at least 10 test tasks by the deadline. Otherwise resolve NO. Missing test evidence makes the market invalid.",
    resolutionSource: "Synthetic activity record supplied by the test operator.",
  },
].map((market) => ({
  ...market,
  status: "open" as const,
  synthetic: "yes",
  closesAt: new Date("2030-12-31T12:00:00Z"),
  publishedAt: new Date("2030-01-01T12:00:00Z"),
}));
