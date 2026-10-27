import { expect } from "bun:test";
import { Schema } from "effect";
import { startPipe } from "./real-pipe-client";

export async function successfulCall(pipe: ReturnType<typeof startPipe>, id: string) {
  await pipe.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "app:info" } });
  const message = await pipe.response(id);
  const result = Schema.decodeUnknownSync(
    Schema.Struct({
      isError: Schema.Boolean,
      structuredContent: Schema.JsonObject,
      content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
    }),
  )(message.result);
  expect(message.error).toBeUndefined();
  expect(result.isError).toBe(false);
  expect(result.structuredContent.ok).toBe(true);
  expect(result.structuredContent.result).toEqual({ value: "real-pipe", items: [2, 7] });
  expect(result.content).toHaveLength(1);
  expect(JSON.parse(result.content[0]?.text ?? "null")).toEqual(result.structuredContent);
}

export async function abandonment(
  command: readonly string[],
  cwd: string,
  scenario: { readonly kind: "tool" | "resource"; readonly shutdown: "EOF" | "SIGTERM" | "cancel" },
) {
  // Given a real pipe with active yielding work and a queued tool behind maxConcurrent=1.
  await using pipe = startPipe(command, cwd);
  await pipe.initialize();
  const { kind, shutdown } = scenario;
  await pipe.send({
    jsonrpc: "2.0",
    id: "abandoned",
    method: kind === "tool" ? "tools/call" : "resources/read",
    params: kind === "tool" ? { name: "app:logs" } : { uri: "lando://real-pipe/follow" },
  });
  await pipe.waitFor(
    () => pipe.diagnostics.some((entry) => entry.event === "started" && entry.kind === kind),
    "stderr",
  );
  if (kind === "tool") {
    await pipe.send({ jsonrpc: "2.0", id: "queued", method: "tools/call", params: { name: "app:exec" } });
  }
  await pipe.send({ jsonrpc: "2.0", id: "barrier", method: "ping" });
  expect(await pipe.response("barrier")).toEqual({ jsonrpc: "2.0", id: "barrier", result: {} });

  // When EOF, an OS signal, or explicit cancellation abandons the request.
  switch (shutdown) {
    case "EOF":
      await pipe.closeInput();
      break;
    case "SIGTERM":
      pipe.child.kill("SIGTERM");
      break;
    case "cancel":
      if (kind === "tool") {
        await pipe.send({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: "queued" },
        });
      }
      await pipe.send({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: "abandoned" },
      });
      await pipe.waitFor(
        () => pipe.diagnostics.some((entry) => entry.event === "finalized" && entry.kind === kind),
        "stderr",
      );
      await successfulCall(pipe, "after-cancel");
      await pipe.send({ jsonrpc: "2.0", id: "after-cancel-ping", method: "ping" });
      expect(await pipe.response("after-cancel-ping")).toEqual({
        jsonrpc: "2.0",
        id: "after-cancel-ping",
        result: {},
      });
      await pipe.closeInput();
      break;
  }

  // Then all readers reach EOF, cleanup runs once, and no reply of any kind escapes for either ID.
  expect(await pipe.finish()).toBe(0);
  expect(pipe.messages.filter((message) => message.id === "abandoned" || message.id === "queued")).toEqual(
    [],
  );
  expect(pipe.diagnostics.filter((entry) => entry.event === "started")).toEqual([{ event: "started", kind }]);
  expect(pipe.diagnostics.filter((entry) => entry.event === "queuedExecuted")).toEqual([]);
  expect(pipe.diagnostics.filter((entry) => entry.event === "finalized")).toEqual([
    { event: "finalized", kind },
    { event: "finalized", kind: "runtime" },
  ]);
  const exits = pipe.diagnostics.filter((entry) => entry.event === "serverExit");
  expect(exits).toHaveLength(1);
  if (shutdown === "SIGTERM") {
    expect(exits[0]).toMatchObject({ event: "serverExit", exit: "Failure", interruptedOnly: true });
    expect(exits[0]?.cause).toBeDefined();
  } else {
    expect(exits).toEqual([{ event: "serverExit", exit: "Success" }]);
  }
  if (shutdown === "cancel")
    expect(pipe.messages.filter((message) => message.id === "after-cancel")).toHaveLength(1);
}
