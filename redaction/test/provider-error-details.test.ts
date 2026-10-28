import { expect, test } from "bun:test";
import { encodeCommandResult, identityRedactor, taggedErrorJson } from "@lando/sdk/command-result";
import { ProviderCapabilityError, ProviderUnavailableError } from "@lando/sdk/errors";
import { Effect, Schema } from "effect";
import { redactProviderError } from "../src/provider-error.ts";
import { makeRedactionService } from "../src/service.ts";

const secret = "provider-detail-canary";
const project = async (details: unknown) => {
  const service = makeRedactionService();
  await Effect.runPromise(service.registerValues([secret]));
  const redactor = await Effect.runPromise(service.forProfile("secrets"));
  return redactProviderError(
    new ProviderUnavailableError({
      providerId: "test",
      operation: "run.volume",
      message: "Failed",
      remediation: "Run doctor",
      details,
    }),
    redactor,
  );
};
test("provider details omit secret keys recursively and mask native Error name and message", async () => {
  const error = new Error(secret);
  error.name = secret;
  const result = await project({
    [secret]: "hidden",
    safe: [{ [`prefix${secret}`]: 1, status: 503 }],
    error,
    "[redacted]": "safe marker",
  });
  const wire = JSON.parse(JSON.stringify(taggedErrorJson(result)));
  expect(JSON.stringify(wire)).not.toContain(secret);
  expect(wire.details.safe).toEqual([{ status: 503 }]);
  expect(wire.details.error).toEqual({ name: "[redacted]", message: "[redacted]" });
  expect(wire.details["[redacted]"]).toBe("safe marker");
});
test("provider details never execute accessors, serialization hooks, or proxy traps", async () => {
  let calls = 0;
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const input = {
    safe: 503,
    get dangerous() {
      calls++;
      throw new Error("getter");
    },
    toJSON() {
      calls++;
      return secret;
    },
    proxy: new Proxy(
      {},
      {
        ownKeys() {
          calls++;
          throw new Error("trap");
        },
      },
    ),
    revoked: revoked.proxy,
  };
  const result = await project(input);
  expect(calls).toBe(0);
  expect((result.details as { safe: number }).safe).toBe(503);
  expect(() => JSON.stringify(taggedErrorJson(result))).not.toThrow();
});
test("provider details bound cycles, deep trees, wide arrays and repeated references", async () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  let deep: unknown = secret;
  for (let i = 0; i < 50; i++) deep = { deep };
  const result = await project({
    cyclic,
    deep,
    wide: Array(300).fill(secret),
    repeated: Array(200).fill({ value: "x".repeat(1000) }),
  });
  const wire = JSON.stringify(taggedErrorJson(result));
  expect(wire).not.toContain(secret);
  expect(wire.length).toBeLessThan(100000);
});

test("projection skips array hooks, inherited fields, and exotic values", async () => {
  let calls = 0;
  const array = [secret, { status: 503 }];
  Object.defineProperty(array, "map", {
    value: () => {
      calls++;
      throw new Error("map");
    },
  });
  Object.defineProperty(array, "toJSON", {
    value: () => {
      calls++;
      throw new Error("json");
    },
  });
  Object.defineProperty(array, Symbol.iterator, {
    value: () => {
      calls++;
      throw new Error("iterator");
    },
  });
  const proto = Object.create(null);
  Object.defineProperty(proto, "__proto__", { value: { status: 503 }, enumerable: true });
  proto.constructor = "safe";
  proto.prototype = "safe";
  const result = await project({ array, proto, exotic: new Date(), bigint: 1n, symbol: Symbol(secret) });
  const details = result.details as Record<string, unknown>;
  expect(details.array).toEqual(["[redacted]", { status: 503 }]);
  expect(Object.getPrototypeOf(details)).toBeNull();
  expect(Object.getPrototypeOf(details.proto)).toBeNull();
  expect(Object.hasOwn(details.proto as object, "__proto__")).toBe(true);
  expect(calls).toBe(0);
});

test("projection masks oversized strings and omits oversized keys without partial secrets", async () => {
  const result = await project({
    status: 503,
    huge: "x".repeat(17000) + secret,
    ["x".repeat(17000) + secret]: "hidden",
  });
  expect(result.details).toEqual({ status: 503, huge: "[redacted]" });
});

test("capability values and identity command wires omit colliding Unicode and control secret keys", async () => {
  const service = makeRedactionService();
  const tokens = [secret, "二番目秘密", "control\n\tsecret"];
  await Effect.runPromise(service.registerValues(tokens));
  const redactor = await Effect.runPromise(service.forProfile("secrets"));
  const values: Record<string, unknown> = Object.fromEntries(
    tokens.flatMap((token) => [
      [token, "hidden"],
      [`prefix${token}suffix`, "hidden"],
    ]),
  );
  values["[redacted]"] = "safe marker";
  values.status = 503;
  const error = redactProviderError(
    new ProviderCapabilityError({
      providerId: "test",
      operation: "run.volume",
      message: "Failed",
      remediation: "Run doctor",
      capability: "volume",
      requiredValue: values,
      actualValue: [values],
      details: values,
    }),
    redactor,
  );
  const wire = await Effect.runPromise(
    encodeCommandResult({
      command: "fixture",
      resultSchema: Schema.Unknown,
      outcome: { _tag: "failure", error, additionalErrors: [] },
      redactor: identityRedactor,
    }),
  );
  const decoded = JSON.parse(wire);
  expect(decoded.error.details).toEqual({ "[redacted]": "safe marker", status: 503 });
  expect(decoded.error.requiredValue).toEqual(decoded.error.details);
  expect(decoded.error.actualValue).toEqual([decoded.error.details]);
  for (const token of tokens) expect(JSON.stringify(decoded)).not.toContain(token);
});

test("native Error accessor and inherited fields never execute and debug fields stay absent", async () => {
  let calls = 0;
  const error = new Error("safe");
  Object.defineProperty(error, "name", {
    get() {
      calls++;
      return secret;
    },
    enumerable: true,
  });
  Object.defineProperty(error, "message", {
    get() {
      calls++;
      return secret;
    },
    enumerable: true,
  });
  Object.defineProperty(error, "stack", {
    get() {
      calls++;
      return secret;
    },
    enumerable: true,
  });
  Object.defineProperty(error, "cause", { value: secret, enumerable: true });
  const other = new Error("safe");
  const inherited = Object.create(Error.prototype);
  Object.defineProperty(inherited, "name", {
    get() {
      calls++;
      return secret;
    },
  });
  Object.setPrototypeOf(other, inherited);
  const result = await project({ error, other });
  expect(calls).toBe(0);
  expect(result.details).toEqual({
    error: { name: "[redacted]", message: "[redacted]" },
    other: { message: "safe" },
  });
});

test("local cycle depth and width limits retain safe sibling diagnostics", async () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  let deep: unknown = secret;
  for (let i = 0; i < 20; i++) deep = { next: deep };
  for (const subtree of [
    cyclic,
    deep,
    Array(257).fill(secret),
    Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`key${i}`, secret])),
  ]) {
    const result = await project({ status: 503, subtree });
    expect((result.details as Record<string, unknown>).status).toBe(503);
    expect(JSON.stringify(result.details)).not.toContain(secret);
  }
});

test("aggregate repeated expansion and canonical redaction expansion fail closed", async () => {
  const shared = { value: "x".repeat(1000) };
  expect((await project(Array(200).fill(shared))).details).toBe("[redacted]");
  const service = makeRedactionService();
  await Effect.runPromise(service.registerValues(["x"]));
  const redactor = await Effect.runPromise(service.forProfile("secrets"));
  const error = redactProviderError(
    new ProviderUnavailableError({
      providerId: "test",
      operation: "run.volume",
      message: "Failed",
      remediation: "Run doctor",
      details: Array(200).fill("x".repeat(100)),
    }),
    redactor,
  );
  expect(error.details).toBe("[redacted]");
});

test.each(["503", " ", "\n", "\u001b[32m"])(
  "authoritative token %j is omitted from keys while numeric status survives",
  async (token) => {
    const service = makeRedactionService();
    const redactor = await Effect.runPromise(service.forProfile("secrets", { authoritativeTokens: [token] }));
    const error = redactProviderError(
      new ProviderUnavailableError({
        providerId: "test",
        operation: "run.volume",
        message: "Failed",
        remediation: "Retry",
        details: { [token]: "hidden", status: 503, exitCode: 7, value: `prefix${token}suffix` },
      }),
      redactor,
    );
    const decoded = JSON.parse(JSON.stringify(taggedErrorJson(error)));
    expect(decoded.details.status).toBe(503);
    expect(decoded.details.exitCode).toBe(7);
    expect(Object.hasOwn(decoded.details, token)).toBe(false);
    expect(decoded.details.value).not.toContain(token);
  },
);

test("failed canonical redaction fails closed", async () => {
  const original = new ProviderUnavailableError({
    providerId: "test",
    operation: "run.volume",
    message: "Failed",
    remediation: "Retry",
    details: { status: 503 },
  });
  const redacted = redactProviderError(original, {
    redactString: (value) => value,
    redactValue: () => {
      throw new Error("redactor failure");
    },
  });
  expect(redacted.details).toBe("[redacted]");
});
