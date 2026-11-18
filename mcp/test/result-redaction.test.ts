import { expect, test } from "bun:test";
import { makeRedactionService } from "@lando/redaction/service";
import { resolveCommandCompletion } from "@lando/sdk/command-result";
import { SecretRef } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";
import { Effect, Schema } from "effect";
import { dispatchTool } from "../src/dispatch.ts";
import { commandResult } from "../src/tool-result.ts";

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

test("preserves schema exemptions in the final MCP serialization", async () => {
  // Given: a result whose schema declares a secret-ref descriptor, a typed
  // number under a secret-named key, and a schema literal under a secret-named key.
  const redactor = createRedactor("secrets");
  const value = {
    password: { _tag: "SecretRef" as const, reference: "DB_PASSWORD" },
    tokenCount: 4,
    secretMode: "env" as const,
  };
  const entry = {
    kind: "command" as const,
    spec: {
      id: "app:exempt",
      summary: "Return schema-exempt values",
      resultSchema: Schema.Struct({
        password: SecretRef,
        tokenCount: Schema.Number,
        secretMode: Schema.Literal("env"),
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
        resultRedactor: () => Effect.succeed(redactor),
        execute: () =>
          Effect.succeed(resolveCommandCompletion(entry.spec.id, value, () => ({ ok: true, exitCode: 0 }))),
        notify: () => Effect.void,
      },
    ),
  );
  // Then: the envelope and its final serialization agree with the schema policy.
  expect(result.envelope).toMatchObject({
    ok: true,
    result: { password: { _tag: "SecretRef", reference: "DB_PASSWORD" }, tokenCount: 4, secretMode: "env" },
  });
  expect(result.text).toContain('"tokenCount":4');
  expect(result.text).toContain('"secretMode":"env"');
  expect(result.text).toContain('"reference":"DB_PASSWORD"');
  expect(result.text).not.toContain("[redacted]");
  // And the tool-result surface reuses that text instead of re-serializing it.
  const call = await Effect.runPromise(commandResult(result, { redactor }));
  expect(call.content[0]).toMatchObject({ type: "text", text: result.text });
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
