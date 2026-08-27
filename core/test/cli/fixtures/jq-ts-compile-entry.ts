const run = async (): Promise<void> => {
  const { jqTsEngine } = await import("../../../src/cli/jq/jq-ts-engine.ts");
  const { text } = await jqTsEngine.eval({ a: 1 }, ".a");
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  const parsed: unknown = JSON.parse(trimmed);
  const line = typeof parsed === "number" || typeof parsed === "string" ? String(parsed) : trimmed;
  process.stdout.write(`${line}\n`);
};

void run();
