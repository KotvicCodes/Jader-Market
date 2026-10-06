import { describe, expect, it } from "vitest";
import { initialDemoWallet, simulateTrade } from "../../src/domain/demo";

describe("practice trades", () => {
  it("buys YES shares and restores credits when they are sold", () => {
    const initial = initialDemoWallet();
    const bought = simulateTrade(initial, "yes", "buy", 10, 62);
    expect(bought.wallet).toEqual({ balance: 99_380, yes: 10, no: 0 });
    expect(simulateTrade(bought.wallet, "yes", "sell", 10, 62).wallet).toEqual(initial);
  });
  it("prices NO as the complement and keeps positions separate", () => {
    expect(simulateTrade(initialDemoWallet(), "no", "buy", 3, 62).wallet).toEqual({ balance: 99_886, yes: 0, no: 3 });
  });
  it("allows spending an exact balance but rejects overspending", () => {
    const wallet = { balance: 620, yes: 0, no: 0 };
    expect(simulateTrade(wallet, "yes", "buy", 10, 62).wallet.balance).toBe(0);
    const rejected = simulateTrade(wallet, "yes", "buy", 11, 62);
    expect(rejected.error).toBeDefined();
    expect(rejected.wallet).toEqual(wallet);
  });
  it("rejects selling shares from an outcome the demo does not hold", () => {
    const wallet = { balance: 0, yes: 10, no: 0 };
    const result = simulateTrade(wallet, "no", "sell", 1, 62);
    expect(result.error).toBeDefined();
    expect(result.wallet).toEqual(wallet);
  });
  it.each([0, -1, 1.5, NaN, Infinity, 10_001])("rejects invalid share quantity %s without changing the wallet", quantity => {
    const wallet = initialDemoWallet();
    const result = simulateTrade(wallet, "yes", "buy", quantity, 62);
    expect(result.error).toBeDefined();
    expect(result.wallet).toEqual(wallet);
  });
  it.each([0, 100, 62.5, NaN])("rejects invalid quote %s", price => {
    const wallet = initialDemoWallet();
    const result = simulateTrade(wallet, "yes", "buy", 10, price);
    expect(result.error).toBeDefined();
    expect(result.wallet).toEqual(wallet);
  });
});
