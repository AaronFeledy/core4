import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { McpTransportError, SqlConfirmRequiredError } from "@lando/sdk/errors";

import {
  MAX_ADDITIONAL_FAILURE_COUNT,
  inspectMcpCommandOutcome,
  projectMcpProgressFrame,
} from "@lando/mcp/result-inspector";
import { MAX_OUTBOUND_QUEUED_BYTES } from "@lando/mcp/stdio-limits";
import { buildCommandResultEnvelope, identityRedactor } from "@lando/sdk/command-result";

test("bounds the combined encoded error rather than each failure independently", () => {
  // Given: individually bounded failures whose combined encoding exceeds the limit.
  const message = "x".repeat(MAX_OUTBOUND_QUEUED_BYTES / 2);
  // When: the outcome passes through inspection.
  const result = Effect.runSync(
    Effect.result(
      inspectMcpCommandOutcome({
        _tag: "failure",
        error: { _tag: "StartError", message },
        additionalErrors: [{ role: "cleanup", error: { _tag: "CleanupError", message } }],
      }),
    ),
  );
  // Then: the aggregate failure is rejected before transport serialization.
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "McpTransportError" } });
});

test("bounds additional failure count independently of the byte budget", () => {
  const errors = Array.from({ length: MAX_ADDITIONAL_FAILURE_COUNT + 1 }, () => ({
    role: "peer" as const,
    error: "small",
  }));
  const result = Effect.runSync(
    Effect.result(inspectMcpCommandOutcome({ _tag: "failure", error: "primary", additionalErrors: errors })),
  );
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "McpTransportError" } });
});

test.each(["role", "error"] as const)(
  "rejects a projected entry's %s getter without invoking it",
  (field) => {
    let calls = 0;
    const entry = { role: "cleanup" as const, error: "secondary" };
    Object.defineProperty(entry, field, {
      get: () => {
        calls++;
        return "hostile";
      },
    });
    const result = Effect.runSync(
      Effect.result(
        inspectMcpCommandOutcome({ _tag: "failure", error: "primary", additionalErrors: [entry] }),
      ),
    );
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "McpTransportError" } });
    expect(calls).toBe(0);
  },
);

test.each(["error-getter", "error-proxy", "array-getter", "array-proxy"] as const)(
  "rejects an additional failure with %s without invoking its hooks",
  (kind) => {
    // Given: a hostile error or collection alongside a valid primary failure.
    let hookCalls = 0;
    const accessorError = {
      _tag: "CleanupError",
      get message(): string {
        hookCalls += 1;
        return "not-read";
      },
    };
    const handler = {
      getOwnPropertyDescriptor: (target: object, key: string | symbol) => {
        hookCalls += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    };
    const errors: Array<{ readonly role: "cleanup"; readonly error: unknown }> = [];
    switch (kind) {
      case "error-getter":
        errors.push({ role: "cleanup", error: accessorError });
        break;
      case "error-proxy":
        errors.push({ role: "cleanup", error: new Proxy(accessorError, handler) });
        break;
      case "array-getter":
        Object.defineProperty(errors, "0", {
          get: () => {
            hookCalls += 1;
            return accessorError;
          },
        });
        break;
      case "array-proxy":
        errors.push({ role: "cleanup", error: { _tag: "CleanupError", message: "not-read" } });
        break;
      default:
        return kind satisfies never;
    }
    const additionalErrors = kind === "array-proxy" ? new Proxy<typeof errors>(errors, handler) : errors;
    // When: inspection encounters the additional failures.
    const result = Effect.runSync(
      Effect.result(
        inspectMcpCommandOutcome({
          _tag: "failure",
          error: { _tag: "StartError", message: "start" },
          additionalErrors,
        }),
      ),
    );
    // Then: protections reject hostile data without executing it.
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "McpTransportError" } });
    expect(hookCalls).toBe(0);
  },
);

test("retains SQL confirmation projection when a failure passes MCP inspection", () => {
  const steps = [{ id: "reset", label: "Reset", target: "database", destructive: true }];
  const error = new SqlConfirmRequiredError({
    message: "Confirm reset",
    service: "database",
    steps,
    remediation: "Use --yes",
  });
  const envelope = Effect.runSync(
    inspectMcpCommandOutcome({ _tag: "failure", error, additionalErrors: [] }).pipe(
      Effect.flatMap((outcome) =>
        buildCommandResultEnvelope({
          command: "app:db:reset",
          resultSchema: Schema.Unknown,
          outcome,
          redactor: identityRedactor,
        }),
      ),
    ),
  );
  expect(envelope.error).toEqual({
    _tag: "SqlConfirmRequiredError",
    message: "Confirm reset",
    remediation: "Use --yes",
    service: "database",
    steps,
  });
});

test("omits a hidden accessor before result-schema encoding", async () => {
  // Given
  let getterCalls = 0;
  const result = {};
  Object.defineProperty(result, "nested", {
    get: () => {
      getterCalls += 1;
      return { value: "not-read" };
    },
  });

  // When
  const envelope = await Effect.runPromise(
    inspectMcpCommandOutcome({ _tag: "success", value: result }).pipe(
      Effect.flatMap((outcome) =>
        buildCommandResultEnvelope({
          command: "app:hidden-result",
          resultSchema: Schema.Struct({ nested: Schema.Struct({ value: Schema.String }) }),
          outcome,
          redactor: identityRedactor,
        }),
      ),
    ),
  );

  // Then
  expect(envelope).toMatchObject({
    ok: false,
    error: { _tag: "CommandResultEncodeError" },
  });
  expect(getterCalls).toBe(0);
});

test("omits a proxy-valued failure field without invoking traps before envelope encoding", () => {
  let trapCalls = 0;
  const proxy = new Proxy(
    {},
    {
      get: () => {
        trapCalls += 1;
        return "hidden";
      },
      getPrototypeOf: () => {
        trapCalls += 1;
        return Object.prototype;
      },
      ownKeys: () => {
        trapCalls += 1;
        return ["hidden"];
      },
      getOwnPropertyDescriptor: () => {
        trapCalls += 1;
        return { value: "hidden", enumerable: true, configurable: true };
      },
    },
  );
  const error = { _tag: "ProxyFieldError", message: "failure", path: "/x", value: proxy };

  const envelope = Effect.runSync(
    inspectMcpCommandOutcome({ _tag: "failure", error, additionalErrors: [] }).pipe(
      Effect.flatMap((outcome) =>
        buildCommandResultEnvelope({
          command: "app:info",
          resultSchema: Schema.Unknown,
          outcome,
          redactor: identityRedactor,
        }),
      ),
    ),
  );

  expect(envelope.error).toEqual({ _tag: "ProxyFieldError", message: "failure", path: "/x" });
  expect(trapCalls).toBe(0);
});

test("rejects a proxy error itself without enumerating passthrough fields", () => {
  let trapCalls = 0;
  const error = new Proxy(
    {},
    {
      ownKeys: () => {
        trapCalls += 1;
        return [];
      },
      getOwnPropertyDescriptor: () => {
        trapCalls += 1;
        return undefined;
      },
      getPrototypeOf: () => {
        trapCalls += 1;
        return Object.prototype;
      },
    },
  );

  const exit = Effect.runSync(
    Effect.result(inspectMcpCommandOutcome({ _tag: "failure", error, additionalErrors: [] })),
  );

  expect(exit).toMatchObject({ _tag: "Failure", failure: { _tag: "McpTransportError" } });
  expect(trapCalls).toBe(0);
});

test("projects only plain descriptor-safe progress data", () => {
  // Given
  let toJsonCalls = 0;
  let ignoredGetterCalls = 0;
  const withIgnoredAccessor = { _tag: "stdout", chunk: "hello" };
  Object.defineProperty(withIgnoredAccessor, "ignored", {
    enumerable: true,
    get: () => {
      ignoredGetterCalls += 1;
      return "not-read";
    },
  });
  const withToJson = {
    _tag: "stdout",
    chunk: "not-read",
    toJSON: () => {
      toJsonCalls += 1;
      return {};
    },
  };
  class ExoticFrame {
    readonly _tag = "stderr";
    readonly chunk = "not-read";
  }

  // When
  const projected = projectMcpProgressFrame({ _tag: "stdout", chunk: "hello", service: "web" });
  const projectedWithIgnoredAccessor = projectMcpProgressFrame(withIgnoredAccessor);
  const toJsonFailure = () => projectMcpProgressFrame(withToJson);
  const exoticFailure = () => projectMcpProgressFrame(new ExoticFrame());

  // Then
  expect(projected).toEqual({ _tag: "stdout", chunk: "hello", service: "web" });
  expect(projectedWithIgnoredAccessor).toEqual({ _tag: "stdout", chunk: "hello" });
  expect(toJsonFailure).toThrow(McpTransportError);
  expect(exoticFailure).toThrow(McpTransportError);
  expect(toJsonCalls).toBe(0);
  expect(ignoredGetterCalls).toBe(0);
});
