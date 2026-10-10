import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Use the existing JavaScript TypeScript compiler for operator scripts. Native
// transpilers may belong to another host when a checkout is shared across OSes.
const sourceRoots = ["../src/", "./", "../tests/"].map(path => new URL(path, import.meta.url).href);
const isSource = url => sourceRoots.some(root => url?.startsWith(root));

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (isSource(context.parentURL) && (specifier.startsWith("./") || specifier.startsWith("../"))) {
      const target = new URL(specifier, context.parentURL);
      if (isSource(target.href) && !extname(target.pathname)) {
        target.pathname += ".ts";
        return nextResolve(target.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (isSource(url) && extname(new URL(url).pathname) === ".ts") {
      const result = ts.transpileModule(readFileSync(new URL(url), "utf8"), {
        fileName: fileURLToPath(url),
        reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true },
      });
      if (result.diagnostics?.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)) {
        throw new Error("The operator script could not be compiled. Run the project type check.");
      }
      return { format: "module", source: result.outputText, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
