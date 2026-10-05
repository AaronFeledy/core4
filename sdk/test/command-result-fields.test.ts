import { expect, test } from "bun:test";
import {
  buildCommandResultEnvelope,
  encodeCommandResult,
  encodeStreamResultFrame,
  identityRedactor,
} from "@lando/sdk/command-result";
import { ConfigError, ConfigExpressionError } from "@lando/sdk/errors";
import { CommandResultEnvelope, StreamFrame } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";
import { Effect, Option, Redacted, Schema } from "effect";

const expressionError = new ConfigExpressionError({
  message: "Expression resolved to a missing value.",
  path: "services.appserver.environment.GREETING",
  expression: "hi-{{ app.nope }}",
  filePath: "/app/.lando.yml",
  remediation: "Fix the expression.",
});
const options = (error: unknown) => ({
  command: "app:cache:refresh",
  resultSchema: Schema.Unknown,
  outcome: { _tag: "failure", error } as const,
  redactor: identityRedactor,
});

for (const format of ["json", "yaml"] as const) {
  test(`preserves expression context when a failure is encoded as ${format}`, () => {
    const input = { ...options(expressionError), format };
    const line = Effect.runSync(encodeCommandResult(input));
    const envelope = Schema.decodeUnknownSync(CommandResultEnvelope)(
      format === "json" ? JSON.parse(line) : Bun.YAML.parse(line),
    );
    expect(envelope.error).toMatchObject({
      path: "services.appserver.environment.GREETING",
      expression: "hi-{{ app.nope }}",
      filePath: "/app/.lando.yml",
    });
  });
}

test("preserves expression context when building an MCP envelope", () => {
  const input = options(expressionError);
  const envelope = Effect.runSync(buildCommandResultEnvelope(input));
  expect(envelope.error).toMatchObject({
    path: "services.appserver.environment.GREETING",
    expression: "hi-{{ app.nope }}",
    filePath: "/app/.lando.yml",
  });
});

test("preserves expression context when encoding a terminal stream frame", () => {
  const input = options(expressionError);
  const line = Effect.runSync(encodeStreamResultFrame(input));
  const frame = Schema.decodeUnknownSync(StreamFrame)(JSON.parse(line));
  expect(frame).toMatchObject({
    _tag: "result",
    envelope: {
      error: {
        path: "services.appserver.environment.GREETING",
        expression: "hi-{{ app.nope }}",
        filePath: "/app/.lando.yml",
      },
    },
  });
});

test("preserves ConfigError path when its cause is excluded", () => {
  const error = new ConfigError({
    message: "Invalid config",
    path: "proxy.domain",
    cause: { token: "private" },
  });
  const envelope = Effect.runSync(buildCommandResultEnvelope(options(error)));
  expect(envelope.error).toEqual({ _tag: "ConfigError", message: "Invalid config", path: "proxy.domain" });
});

test("omits entire unsafe fields when projecting an error", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const shared = { value: "shared" };
  const deep = Array.from({ length: 34 }).reduce<unknown>((nested) => ({ nested }), "leaf");
  const error = Object.assign(Object.create({ inherited: "hidden" }), {
    _tag: "UnsafeError",
    message: "failure",
    safe: { list: [null, true, 3, "text"], shared: [shared, shared], empty: Object.create(null) },
    absent: undefined,
    fn: () => "hidden",
    symbol: Symbol("hidden"),
    bigint: 1n,
    infinity: Number.POSITIVE_INFINITY,
    nan: Number.NaN,
    instance: new Error("hidden"),
    date: new Date(0),
    redacted: Redacted.make("hidden"),
    option: Option.some("hidden"),
    cycle,
    deep,
    invalidObject: { value: undefined },
    invalidArray: ["ok", undefined],
    sparse: new Array(1),
    cause: { path: "hidden" },
    stack: "hidden",
    redactionTokens: ["hidden"],
  });
  const envelope = Effect.runSync(buildCommandResultEnvelope(options(error)));
  expect(envelope.error).toEqual({
    _tag: "UnsafeError",
    message: "failure",
    safe: { list: [null, true, 3, "text"], shared: [{ value: "shared" }, { value: "shared" }], empty: {} },
  });
});

test("omits proxy fields without invoking traps when projecting an error", () => {
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
  const error = {
    _tag: "ProxyFieldError",
    message: "failure",
    direct: proxy,
    nested: { proxy },
    array: [proxy],
  };

  const line = Effect.runSync(encodeCommandResult(options(error)));

  expect(Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(line)).error).toEqual({
    _tag: "ProxyFieldError",
    message: "failure",
  });
  expect(trapCalls).toBe(0);
});

for (const kind of ["object", "array"] as const) {
  for (const descriptorKind of ["method", "accessor", "non-callable"] as const) {
    test(`omits ${kind} fields with an own toJSON ${descriptorKind} when encoding`, () => {
      let serializerCalls = 0;
      const value = kind === "array" ? ["hidden"] : { hidden: "value" };
      const serialize = () => {
        serializerCalls += 1;
        return "hidden";
      };
      Object.defineProperty(
        value,
        "toJSON",
        descriptorKind === "accessor"
          ? { get: serialize }
          : { value: descriptorKind === "method" ? serialize : "hidden" },
      );
      const error = { _tag: "SerializerFieldError", message: "failure", value };

      const line = Effect.runSync(encodeCommandResult(options(error)));

      expect(Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(line)).error).toEqual({
        _tag: "SerializerFieldError",
        message: "failure",
      });
      expect(serializerCalls).toBe(0);
    });
  }
}

test("omits arrays with exotic prototypes when projecting an error", () => {
  class ExoticArray extends Array<string> {}
  const error = { _tag: "ExoticArrayError", message: "failure", value: new ExoticArray("hidden") };

  const envelope = Effect.runSync(buildCommandResultEnvelope(options(error)));

  expect(envelope.error).toEqual({ _tag: "ExoticArrayError", message: "failure" });
});

test("omits own accessors without invoking getters when projecting an error", () => {
  let getterCalls = 0;
  const error = { _tag: "AccessorFieldError", message: "failure", path: "/x" };
  for (const key of ["extra", "cause", "stack"])
    Object.defineProperty(error, key, {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "hidden";
      },
    });

  const envelope = Effect.runSync(buildCommandResultEnvelope(options(error)));

  expect(envelope.error).toEqual({ _tag: "AccessorFieldError", message: "failure", path: "/x" });
  expect(getterCalls).toBe(0);
});

test("omits malformed typed fields instead of falling back when extras are valid", () => {
  const error = {
    _tag: "WrongShapesError",
    message: "failure",
    remediation: 42,
    reason: { value: "nope" },
    issues: ["invalid"],
    service: "not a SQL confirmation",
    steps: [{ id: "invalid" }],
    path: "config.path",
  };
  const line = Effect.runSync(encodeCommandResult(options(error)));
  const envelope = Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(line));
  expect(envelope.error).toEqual({ _tag: "WrongShapesError", message: "failure", path: "config.path" });
});

test("redacts secrets when they appear in a passthrough expression field", () => {
  const secret = "private-expression-token";
  const error = new ConfigExpressionError({
    message: expressionError.message,
    remediation: expressionError.remediation,
    path: expressionError.path,
    filePath: expressionError.filePath,
    expression: `hi-${secret}-{{ app.nope }}`,
  });
  const input = { ...options(error), redactor: createRedactor("secrets", { values: [secret] }) };
  const line = Effect.runSync(encodeCommandResult(input));
  const envelope = Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(line));
  expect(envelope.error?.expression).toBe("hi-[redacted]-{{ app.nope }}");
  expect(line).not.toContain(secret);
});
