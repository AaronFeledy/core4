import { expect, test } from "bun:test";
import { McpRuntimeConfig, McpService } from "@lando/mcp/service";
import { startStdioClient } from "@lando/mcp/testing";
import { RedactionService, registerRedactionValues } from "@lando/redaction/service";
import { createRedactor } from "@lando/sdk/secrets";
import { Effect, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
import { requireConfirmation } from "../../src/cli/require-confirmation";
import { serviceLayer } from "../../src/mcp-command-executor";

const fixture = () => {
  let executions = 0;
  const spec = {
    id: "app:rebuild",
    summary: "Rebuild",
    resultSchema: Schema.Struct({ executions: Schema.Number }),
    flags: { yes: { type: "boolean" } },
    run: (input: { readonly flags: Record<string, unknown> }) =>
      requireConfirmation({
        yes: input.flags.yes === true,
        message: "Rebuild fixture-app and replace its services?",
      }).pipe(Effect.andThen(Effect.sync(() => ({ executions: ++executions })))),
  };
  const layer = serviceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          McpRuntimeConfig,
          McpRuntimeConfig.of({
            commandEntries: [{ spec }],
            defaultAllowlist: [spec.id],
            runtimeLayer: Layer.empty,
          }),
        ),
        Layer.succeed(
          RedactionService,
          RedactionService.of({
            registerValues: registerRedactionValues,
            forProfile: () => Effect.succeed(createRedactor("secrets")),
          }),
        ),
      ),
    ),
  );
  return { layer, executions: () => executions };
};

test.each(["accept-true", "accept-false", "decline", "cancel", "reverse-failure"])(
  "elicitation maps %s to confirmation without tool cancellation",
  async (answer) => {
    const host = fixture();
    const response = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* McpService;
          const client = yield* startStdioClient(service.serve({ transport: "stdio" }), { elicitation: {} });
          const call = yield* client.sendRequest("tools/call", { name: "app:rebuild" });
          let reverse = yield* client.next;
          while (reverse.method !== "elicitation/create") reverse = yield* client.next;
          expect(reverse.params).toMatchObject({
            requestedSchema: {
              type: "object",
              properties: { confirm: { type: "boolean" } },
              required: ["confirm"],
            },
          });
          if (typeof reverse.id !== "string" && typeof reverse.id !== "number")
            throw new Error("Expected reverse request id");
          if (answer === "reverse-failure")
            yield* client.send({
              jsonrpc: "2.0",
              id: reverse.id,
              error: { code: -32603, message: "Client declined to display the form." },
            });
          else
            yield* client.send({
              jsonrpc: "2.0",
              id: reverse.id,
              result: answer.startsWith("accept")
                ? { action: "accept", content: { confirm: answer === "accept-true" } }
                : { action: answer },
            });
          return yield* call.response;
        }),
      ).pipe(Effect.provide(host.layer)),
    );
    if (answer === "accept-true") {
      expect(response).toMatchObject({
        result: { isError: false, structuredContent: { ok: true, result: { executions: 1 } } },
      });
      expect(host.executions()).toBe(1);
    } else {
      expect(response).toMatchObject({
        result: {
          isError: true,
          structuredContent: { ok: false, error: { _tag: "CommandConfirmationError", reason: "declined" } },
        },
      });
      expect(host.executions()).toBe(0);
    }
  },
);

test("elicitation without an answer declines at 120 seconds", async () => {
  const host = fixture();
  const response = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* McpService;
        const client = yield* startStdioClient(service.serve({ transport: "stdio" }), { elicitation: {} });
        const call = yield* client.sendRequest("tools/call", { name: "app:rebuild" });
        let reverse = yield* client.next;
        while (reverse.method !== "elicitation/create") reverse = yield* client.next;
        yield* TestClock.adjust("120 seconds");
        return yield* call.response;
      }),
    ).pipe(Effect.provide(host.layer), Effect.provide(TestClock.layer())),
  );
  expect(response).toMatchObject({
    result: {
      isError: true,
      structuredContent: { error: { _tag: "CommandConfirmationError", reason: "declined" } },
    },
  });
  expect(host.executions()).toBe(0);
});

test.each([false, true])(
  "no-capability preserves non-interactive refusal; yes=%s bypasses confirmation",
  async (yes) => {
    const host = fixture();
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* McpService;
          const client = yield* startStdioClient(service.serve({ transport: "stdio" }));
          const response = yield* client.request("tools/call", {
            name: "app:rebuild",
            arguments: { flags: { yes } },
          });
          return { response, messages: yield* client.messages };
        }),
      ).pipe(Effect.provide(host.layer)),
    );
    expect(observed.messages.filter((message) => message.method === "elicitation/create")).toEqual([]);
    expect(host.executions()).toBe(yes ? 1 : 0);
    expect(observed.response).toMatchObject({
      result: yes
        ? { isError: false, structuredContent: { ok: true } }
        : {
            isError: true,
            structuredContent: { error: { _tag: "CommandConfirmationError", reason: "non-interactive" } },
          },
    });
  },
);

test("yes bypasses elicitation even when the client supports it", async () => {
  const host = fixture();
  const observed = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* McpService;
        const client = yield* startStdioClient(service.serve({ transport: "stdio" }), { elicitation: {} });
        const response = yield* client.request("tools/call", {
          name: "app:rebuild",
          arguments: { flags: { yes: true } },
        });
        return { response, messages: yield* client.messages };
      }),
    ).pipe(Effect.provide(host.layer)),
  );
  expect(observed.response).toMatchObject({ result: { isError: false } });
  expect(observed.messages.filter((message) => message.method === "elicitation/create")).toEqual([]);
});
