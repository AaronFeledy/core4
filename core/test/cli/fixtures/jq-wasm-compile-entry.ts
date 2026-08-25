/**
 * Compile-smoke entry: dynamic-import the same jq engine the CLI uses.
 * bun build --compile must embed or sidecar the wasm so this prints `1`.
 */
const run = async (): Promise<void> => {
  const { jqWasmEngine } = await import("../../../src/cli/jq/jq-wasm-engine.ts");
  const { text } = await jqWasmEngine.eval({ a: 1 }, ".a");
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  const parsed: unknown = JSON.parse(trimmed);
  const line = typeof parsed === "number" || typeof parsed === "string" ? String(parsed) : trimmed;
  process.stdout.write(`${line}\n`);
};

void run();
