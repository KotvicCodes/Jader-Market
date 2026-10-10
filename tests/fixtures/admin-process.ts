import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Options = { recover?: boolean; databaseUrl?: string; secret?: string };

export async function runAdministrator(directory: string, inputs: string[], options: Options = {}) {
  return new Promise<{ code: number | null; output: string; error: string }>((done, fail) => {
    const child = spawn(process.execPath, ["--import", resolve("scripts/register-typescript.mjs"), resolve("scripts/admin.ts"), ...(options.recover ? ["--recover"] : [])], {
      cwd: directory,
      env: {
        ...process.env,
        AUTH_SECRET: options.secret ?? "",
        DATABASE_URL: options.databaseUrl ?? "postgresql://synthetic:synthetic@127.0.0.1:1/synthetic",
        NODE_OPTIONS: ["admin-terminal", "block-native-transpiler"].map(name => `--import=${pathToFileURL(resolve(`tests/fixtures/${name}.mjs`)).href}`).join(" "),
        FORCE_COLOR: "0",
      },
      stdio: "pipe",
    });
    let output = ""; let error = ""; let step = 0;
    const prompts = ["Administrator handle [admin]: ", "Password (12 to 128 characters, hidden): ", "Repeat password (hidden): "];
    const timeout = setTimeout(() => { child.kill(); fail(new Error("Administrator prompt test timed out.")); }, 8000);
    child.stdout.on("data", chunk => {
      output += chunk.toString();
      if (step < inputs.length && output.includes(prompts[step])) {
        child.stdin.write(inputs[step]);
        step++;
        if (step === inputs.length) child.stdin.end();
      }
    });
    child.stderr.on("data", chunk => { error += chunk.toString(); });
    child.on("error", () => { clearTimeout(timeout); fail(new Error("Administrator test process could not start.")); });
    child.on("close", code => { clearTimeout(timeout); done({ code, output, error }); });
  });
}
