import { expect, test } from "bun:test";
import { makeRedactionService } from "@lando/redaction/service";
import { Effect, Schema } from "effect";
import { dispatchTool } from "../src/dispatch.ts";

test("masks the union of overlapping session and result tokens without retaining result tokens", async () => {
  // Given: neither token alone covers the entire overlapping value.
  const service = makeRedactionService();
  await Effect.runPromise(service.registerValues(["abcdef"]));
  const sourceEnv = { API_SECRET: "environment-canary" };
  const redactor = await Effect.runPromise(service.forProfile("secrets", { sourceEnv }));
  const entry = {
    spec: {
      id: "app:overlap",
      summary: "Return overlapping secrets",
      resultSchema: Schema.Struct({ value: Schema.String }),
      run: () => Effect.succeed({ value: "abcdefghi environment-canary" }),
      redactionTokens: () => ["defghi"],
      streamFrames: () => [{ _tag: "stdout" as const, chunk: "abcdefghi environment-canary" }],
    },
  };
  const frames: unknown[] = [];
  // When: one result contributes a token overlapping the session's registration.
  const result = await Effect.runPromise(
    dispatchTool(
      { toolId: entry.spec.id },
      {
        registry: new Map([[entry.spec.id, entry]]),
        effective: new Set([entry.spec.id]),
        allowlistSource: "defaults",
        redactor,
        resultRedactor: (tokens) => service.forProfile("secrets", { sourceEnv, authoritativeTokens: tokens }),
        execute: () => Effect.succeed({ _tag: "success", value: { value: "abcdefghi environment-canary" } }),
        notify: (frame) =>
          Effect.sync(() => {
            frames.push(frame);
          }),
      },
    ),
  );
  // Then: both result surfaces mask the whole union, while session registrations stay unchanged.
  expect(result.envelope).toMatchObject({ result: { value: "[redacted] [redacted]" } });
  expect(JSON.stringify(frames)).not.toContain("ghi");
  expect(redactor.redactString("defghi")).toBe("defghi");
});
