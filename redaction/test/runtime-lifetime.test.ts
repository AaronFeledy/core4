import { expect, test } from "bun:test";
import { createPayloadRedactor } from "@lando/sdk/secrets";
import { SecretStore } from "@lando/sdk/services";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { RedactionService, createPayloadValues, createStandaloneRedactor } from "../src/service.ts";

const open = async () => {
  const scope = Effect.runSync(Scope.make());
  const context = await Effect.runPromise(Layer.buildWithScope(RedactionService.layer, scope));
  return {
    service: Context.get(context, RedactionService),
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
};

test("simultaneous owners isolate registrations and closing A leaves B active", async () => {
  // Given
  const [a, b] = await Promise.all([open(), open()]);
  const ra = await Effect.runPromise(a.service.forProfile("secrets"));
  const rb = await Effect.runPromise(b.service.forProfile("secrets"));
  try {
    // When
    await Promise.all([
      Effect.runPromise(a.service.registerValues(["runtime-a-canary"])),
      Effect.runPromise(b.service.registerValues(["runtime-b-canary"])),
    ]);
    // Then
    expect(ra.redactString("runtime-a-canary runtime-b-canary")).toBe("[redacted] runtime-b-canary");
    expect(rb.redactString("runtime-a-canary runtime-b-canary")).toBe("runtime-a-canary [redacted]");
    await a.close();
    expect(ra.redactString("runtime-a-canary")).toBe("runtime-a-canary");
    expect(rb.redactString("runtime-b-canary")).toBe("[redacted]");
  } finally {
    await a.close();
    await b.close();
  }
});

test("standalone redactors and payload suppliers inherit no runtime registrations", async () => {
  // Given
  const owner = await open();
  const standalone = createStandaloneRedactor("secrets");
  const payload = createPayloadRedactor(createPayloadValues([]));
  try {
    // When
    await Effect.runPromise(owner.service.registerValues(["isolated-runtime-canary"]));
    const output = Buffer.concat([
      payload.write(Buffer.from("isolated-runtime-canary")),
      payload.flush(),
    ]).toString();
    // Then
    expect(standalone.redactString("isolated-runtime-canary")).toBe("isolated-runtime-canary");
    expect(output).toBe("isolated-runtime-canary");
  } finally {
    await owner.close();
  }
});

test("profile, payload and retained observation have zero store lookup authority", async () => {
  // Given
  const calls: string[] = [];
  const store = Layer.succeed(
    SecretStore,
    SecretStore.of({
      id: "trap",
      list: Effect.sync(() => {
        calls.push("list");
        return ["trap"];
      }),
      get: (id) =>
        Effect.sync(() => {
          calls.push(id);
          return "unobserved-store-value";
        }),
      has: () => Effect.die("No secret existence probing"),
    }),
  );
  // When
  const output = await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* RedactionService;
      const redactor = yield* service.forProfile("secrets");
      const values = yield* service.payloadValues();
      yield* service.registerValues(["requested-canary"]);
      values();
      values();
      return redactor.redactValue({ detail: "requested-canary unobserved-store-value" });
    }).pipe(Effect.provide(RedactionService.layer.pipe(Layer.provide(store)))),
  );
  // Then
  expect(output).toEqual({ detail: "[redacted] unobserved-store-value" });
  expect(calls).toEqual([]);
});

test("explicit parent ownership survives closing a consumer layer", async () => {
  // Given
  const owner = await open();
  const layer = RedactionService.layer.pipe(Layer.provide(Layer.succeed(RedactionService, owner.service)));
  try {
    // When
    const same = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* RedactionService;
        yield* service.registerValues(["parent-owned-canary"]);
        return service === owner.service;
      }).pipe(Effect.provide(layer)),
    );
    // Then
    expect(same).toBe(true);
    const redactor = await Effect.runPromise(owner.service.forProfile("secrets"));
    expect(redactor.redactString("parent-owned-canary")).toBe("[redacted]");
  } finally {
    await owner.close();
  }
});

test("payload flush observes late registrations against held overlapping prefixes", async () => {
  // Given
  const owner = await open();
  try {
    await Effect.runPromise(owner.service.registerValues(["held-canary-long"]));
    const supplier = await Effect.runPromise(owner.service.payloadValues());
    const payload = createPayloadRedactor(supplier);
    const prefix = payload.write(Buffer.from("held-canary"));
    // When
    await Effect.runPromise(owner.service.registerValues(["held-canary"]));
    const result = Buffer.concat([prefix, payload.flush()]).toString();
    // Then
    expect(result).toBe("[redacted]");
  } finally {
    await owner.close();
  }
});
