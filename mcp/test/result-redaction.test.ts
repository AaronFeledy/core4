import { expect, test } from "bun:test";
import { makeRedactionService } from "@lando/redaction/service";
import { resolveCommandCompletion } from "@lando/sdk/command-result";
import { createRedactor } from "@lando/sdk/secrets";
import { Effect, Schema } from "effect";
import { dispatchTool } from "../src/dispatch.ts";

test.each([true, false])("masks overlap without retaining tokens (ok=%j)", async (ok) => {
  // Given: neither token alone covers the entire overlapping value.
  const service = makeRedactionService();
  await Effect.runPromise(service.registerValues(["abcdef"]));
  const sourceEnv = { API_SECRET: "environment-canary" };
  const redactor = await Effect.runPromise(service.forProfile("secrets", { sourceEnv }));
  const entry = {
    kind: "command" as const,
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
        execute: () =>
          Effect.succeed(
            resolveCommandCompletion(entry.spec.id, { value: "abcdefghi environment-canary" }, () => ({
              ok,
              exitCode: ok ? 0 : 7,
            })),
          ),
        notify: (frame) =>
          Effect.sync(() => {
            frames.push(frame);
          }),
      },
    ),
  );
  // Then: both result surfaces mask the whole union, while session registrations stay unchanged.
  expect(result.envelope).toMatchObject({ result: { value: "[redacted] [redacted]" } });
  expect(result.ok).toBe(ok);
  expect(JSON.stringify(frames)).not.toContain("ghi");
  expect(redactor.redactString("defghi")).toBe("defghi");
});

test("keeps a published default credential while masking a registered secret", async () => {
  // Given: a result carrying a published default password and a registered private value.
  const service = makeRedactionService();
  await Effect.runPromise(service.registerValues(["private-registered-value"]));
  const redactor = await Effect.runPromise(service.forProfile("secrets"));
  const value = {
    creds: { user: "lando", password: "lando", database: "app" },
    note: "private-registered-value",
  };
  const entry = {
    kind: "command" as const,
    spec: {
      id: "app:info",
      summary: "Return app info credentials",
      resultSchema: Schema.Struct({
        creds: Schema.Struct({ user: Schema.String, password: Schema.String, database: Schema.String }),
        note: Schema.String,
      }),
      run: () => Effect.succeed(value),
    },
  };
  // When
  const result = await Effect.runPromise(
    dispatchTool(
      { toolId: entry.spec.id },
      {
        registry: new Map([[entry.spec.id, entry]]),
        effective: new Set([entry.spec.id]),
        allowlistSource: "defaults",
        redactor,
        resultRedactor: (tokens) => service.forProfile("secrets", { authoritativeTokens: tokens }),
        execute: () =>
          Effect.succeed(resolveCommandCompletion(entry.spec.id, value, () => ({ ok: true, exitCode: 0 }))),
        notify: () => Effect.void,
      },
    ),
  );
  // Then: the published default stays readable, the registered bytes do not.
  expect(result.envelope).toMatchObject({
    result: { creds: { user: "lando", password: "lando", database: "app" }, note: "[redacted]" },
  });
  expect(JSON.stringify(result.envelope)).not.toContain("private-registered-value");
});

test("keeps a schema-fixed result literal that is also a registered value", async () => {
  // Given: a diagnostic result whose kind literal is a registered token.
  const service = makeRedactionService();
  await Effect.runPromise(service.registerValues(["tooling"]));
  const redactor = await Effect.runPromise(service.forProfile("secrets"));
  const value = { commandId: "app:broken", kind: "tooling" as const, message: "tooling failed" };
  const entry = {
    kind: "command" as const,
    spec: {
      id: "app:diagnostics",
      summary: "Return a diagnostic",
      resultSchema: Schema.Struct({
        commandId: Schema.String,
        kind: Schema.Literals(["tooling", "plugin"]),
        message: Schema.String,
      }),
      run: () => Effect.succeed(value),
    },
  };
  // When
  const result = await Effect.runPromise(
    dispatchTool(
      { toolId: entry.spec.id },
      {
        registry: new Map([[entry.spec.id, entry]]),
        effective: new Set([entry.spec.id]),
        allowlistSource: "defaults",
        redactor,
        resultRedactor: (tokens) => service.forProfile("secrets", { authoritativeTokens: tokens }),
        execute: () =>
          Effect.succeed(resolveCommandCompletion(entry.spec.id, value, () => ({ ok: true, exitCode: 0 }))),
        notify: () => Effect.void,
      },
    ),
  );
  // Then: the literal decodes, the free text does not retain the token.
  expect(result.envelope).toMatchObject({
    result: { commandId: "app:broken", kind: "tooling", message: "[redacted] failed" },
  });
});

test("owner failures keep envelope literals and redact generic error tags and free text", async () => {
  const redactor = createRedactor("secrets", { values: ["v4", "apiVersion", "private"] });

  const result = await Effect.runPromise(
    dispatchTool(
      { toolId: "app:broken" },
      {
        registry: new Map(),
        effective: new Set(["app:broken"]),
        allowlistSource: "defaults",
        redactor,
        resultRedactor: () => Effect.succeed(redactor),
        select: () =>
          Effect.succeed({
            _tag: "OwnerFailed",
            commandId: "app:broken",
            outcome: {
              _tag: "failure",
              error: { _tag: "private", message: "v4 private", remediation: "Repair private" },
              additionalErrors: [],
            },
          }),
      },
    ),
  );

  expect(result.ok).toBe(false);
  expect(result.envelope).toMatchObject({
    apiVersion: "v4",
    command: "app:broken",
    ok: false,
    error: {
      _tag: "[redacted]",
      message: "[redacted] [redacted]",
      remediation: "Repair [redacted]",
    },
  });
});
