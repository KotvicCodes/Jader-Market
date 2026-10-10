// Use pipes as an interactive terminal so tests can drive prompts without a PTY.
Object.defineProperty(process.stdin, "isTTY", { value: true });
Object.defineProperty(process.stdout, "isTTY", { value: true });
Object.defineProperty(process.stdout, "columns", { value: 80 });
process.stdin.setRawMode = () => process.stdin;
