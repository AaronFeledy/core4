import { expect, test } from "bun:test";
import { sourceCommand, startPipe } from "./fixtures/real-pipe-client";
import { abandonment, successfulCall } from "./fixtures/real-pipe-scenarios";

test("real stdio preserves the exact successful payload before EOF", async () => {
  // Given an initialized real-process MCP connection.
  await using pipe = startPipe(sourceCommand, import.meta.dir);
  await pipe.initialize();
  // When a successful call finishes before shutdown.
  await successfulCall(pipe, "completed");
  const beforeClose = pipe.messages.filter((message) => message.id !== undefined);
  await pipe.closeInput();
  // Then shutdown preserves the completed response without adding another reply.
  expect(await pipe.finish()).toBe(0);
  expect(pipe.messages.filter((message) => message.id !== undefined)).toEqual(beforeClose);
  expect(pipe.messages.filter((message) => message.id === "completed")).toHaveLength(1);
  expect(pipe.diagnostics).toEqual([
    { event: "finalized", kind: "runtime" },
    { event: "serverExit", exit: "Success" },
  ]);
}, 20_000);

for (const kind of ["tool", "resource"] as const) {
  for (const shutdown of ["EOF", "SIGTERM", "cancel"] as const) {
    test.skipIf(process.platform === "win32" && shutdown === "SIGTERM")(
      `real stdio ${kind} abandonment on ${shutdown} finalizes without a response`,
      async () => {
        await abandonment(sourceCommand, import.meta.dir, { kind, shutdown });
      },
      20_000,
    );
  }
}
