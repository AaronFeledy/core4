import { Schema } from "effect";

export const openStdioSession = (input: {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
}) => {
  const child = Bun.spawn([...input.command], {
    cwd: input.cwd,
    env: input.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const waiting = new Set<(message: Schema.JsonObject) => void>();
  const messages: Schema.JsonObject[] = [];
  const stderr = new Response(child.stderr).text();
  const reader = (async () => {
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of child.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
        const message = Schema.decodeUnknownSync(Schema.JsonObject)(JSON.parse(pending.slice(0, newline)));
        pending = pending.slice(newline + 1);
        messages.push(message);
        for (const waiter of waiting) waiter(message);
      }
    }
  })();
  const waitFor = (match: (message: Schema.JsonObject) => boolean) =>
    new Promise<Schema.JsonObject>((done, fail) => {
      const timer = setTimeout(() => {
        waiting.delete(settle);
        fail(new Error("Timed out waiting for an MCP frame."));
      }, 20_000);
      const settle = (message: Schema.JsonObject) => {
        if (!match(message)) return;
        clearTimeout(timer);
        waiting.delete(settle);
        done(message);
      };
      waiting.add(settle);
    });
  let sequence = 0;
  const sendRaw = async (text: string) => {
    child.stdin.write(text);
    await child.stdin.flush();
  };
  const request = async (method: string, params: Schema.JsonObject = {}) => {
    const id = ++sequence;
    const response = waitFor((message) => message.id === id);
    await sendRaw(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  };
  const initialize = async () => {
    const initialized = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "generations-stdio", version: "1" },
    });
    await sendRaw(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    return initialized;
  };
  const finish = async () => {
    await child.stdin.end();
    const [exit, errors] = await Promise.all([child.exited, stderr, reader]);
    return { exit, stderr: errors, messages };
  };
  return { child, waitFor, sendRaw, request, initialize, finish };
};
