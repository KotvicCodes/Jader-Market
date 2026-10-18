// Shared with the browser; keep this module free of server dependencies.
export const creditTicks = 10_000n;
export const maxQuantity = 1_000_000n;

export function formatCredits(value: bigint) {
  const negative = value < 0n;
  const units = negative ? -value : value;
  const whole = (units / creditTicks).toLocaleString("en-US");
  const decimals = (units % creditTicks).toString().padStart(4, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${negative ? "-" : ""}${whole}.${decimals}`;
}
