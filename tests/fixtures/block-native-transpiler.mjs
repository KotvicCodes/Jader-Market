import { registerHooks } from "node:module";

// Model a native compiler installation that cannot load on the current host.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^(?:tsx|esbuild|@esbuild\/)(?:\/|$)/.test(specifier) || specifier.startsWith("@esbuild/")) {
      throw new Error("Native transpiler blocked by portability test.");
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (/\/node_modules\/(?:tsx|esbuild|@esbuild)\//.test(url)) throw new Error("Native transpiler blocked by portability test.");
    return nextLoad(url, context);
  },
});
