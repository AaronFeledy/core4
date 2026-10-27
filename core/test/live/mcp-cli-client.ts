import { CommandOutputChunk } from "@lando/sdk/schema";
import { Schema } from "effect";

const progressMessage = Schema.Struct({
  method: Schema.Literal("notifications/progress"),
  params: Schema.Struct({
    progressToken: Schema.Union([Schema.String, Schema.Number]),
    message: Schema.String,
  }),
});
const decodeMessage = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject));
const decodeChunk = Schema.decodeUnknownSync(Schema.fromJsonString(CommandOutputChunk));

export const within = async <A>(promise: Promise<A>, label: string, milliseconds = 10_000): Promise<A> => {
  const expired = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => expired.reject(new Error(`${label} exceeded ${milliseconds} ms`)),
    milliseconds,
  );
  try {
    return await Promise.race([promise, expired.promise]);
  } finally {
    clearTimeout(timer);
  }
};

export const mcpCliClient = (binary: string, cwd: string, env: Record<string, string | undefined>) => {
  const child = Bun.spawn([binary, "mcp", "--tooling"], {
    cwd,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const messages: Schema.JsonObject[] = [];
  const pending = new Map<number, ReturnType<typeof Promise.withResolvers<Schema.JsonObject>>>();
  const arrivals = new Set<() => void>();
  const stderr = new Response(child.stderr).text();
  let terminalFailure: Error | undefined;
  let sequence = 0;
  const reading = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const bytes of child.stdout) {
      buffer += decoder.decode(bytes, { stream: true });
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line.length === 0) continue;
        const message = decodeMessage(line);
        messages.push(message);
        if (typeof message.id === "number" && message.method === undefined)
          pending.get(message.id)?.resolve(message);
        for (const arrived of arrivals) arrived();
      }
    }
    if (buffer.trim().length > 0) throw new Error("MCP closed with an incomplete JSON-RPC frame");
  })();
  const failPending = (cause: unknown) => {
    terminalFailure = cause instanceof Error ? cause : new Error("MCP protocol reader failed");
    for (const response of pending.values()) response.reject(terminalFailure);
    for (const arrived of arrivals) arrived();
  };
  void reading.then(() => failPending(new Error("MCP stdout closed")), failPending);
  const send = async (message: Schema.JsonObject) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    await child.stdin.flush();
  };
  const request = async (method: string, params: Schema.JsonObject = {}) => {
    if (terminalFailure !== undefined) throw terminalFailure;
    const id = ++sequence;
    const response = Promise.withResolvers<Schema.JsonObject>();
    pending.set(id, response);
    try {
      await send({ id, method, params });
      return await within(response.promise, method, 60_000);
    } finally {
      pending.delete(id);
    }
  };
  const output = (token: string) =>
    messages.flatMap((message) => {
      if (!Schema.is(progressMessage)(message) || message.params.progressToken !== token) return [];
      return [decodeChunk(message.params.message)];
    });
  const waitForOutput = async (token: string, predicate: (chunk: CommandOutputChunk) => boolean) => {
    const arrived = Promise.withResolvers<void>();
    const inspect = () => {
      if (terminalFailure !== undefined) arrived.reject(terminalFailure);
      else if (output(token).some(predicate)) arrived.resolve();
    };
    arrivals.add(inspect);
    inspect();
    try {
      await within(arrived.promise, "live output");
    } finally {
      arrivals.delete(inspect);
    }
  };
  return {
    messages,
    diagnostics: stderr,
    output,
    request,
    waitForOutput,
    async initialize() {
      await request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "lando-completion-acceptance", version: "1" },
      });
      await send({ method: "notifications/initialized" });
    },
    async beginFollow() {
      const id = ++sequence;
      await send({
        id,
        method: "tools/call",
        params: {
          name: "app:logs",
          arguments: { flags: { follow: true, tail: 1, service: "app" } },
          _meta: { progressToken: "follow" },
        },
      });
      return id;
    },
    cancel: (requestId: number) => send({ method: "notifications/cancelled", params: { requestId } }),
    async close(signal?: "SIGTERM") {
      if (signal === undefined) await child.stdin.end();
      else child.kill(signal);
      const exitCode = await within(child.exited, "MCP shutdown", 5_000);
      await reading;
      return exitCode;
    },
    async dispose() {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      await reading;
      return await stderr;
    },
  };
};
