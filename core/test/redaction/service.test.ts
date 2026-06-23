import { Effect, Layer } from "effect";

import { SecretNotFoundError } from "@lando/core/errors";
import { SecretStore } from "@lando/core/services";
import type { Redactor } from "@lando/sdk/secrets";
import { RedactionService, RedactionServiceLive } from "../../src/redaction/service.ts";

const secretStoreLayer = (values: Record<string, string>) =>
  Layer.succeed(SecretStore, {
    id: "test",
    get: (secret: string) => {
      const value = values[secret];
      return value === undefined
        ? Effect.fail(new SecretNotFoundError({ secret, message: `missing ${secret}` }))
        : Effect.succeed(value);
    },
    has: (secret: string) => Effect.succeed(values[secret] !== undefined),
    list: Effect.succeed(Object.keys(values)),
  });

const runWithStore = <A, E>(effect: Effect.Effect<A, E, RedactionService>, values: Record<string, string>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(RedactionServiceLive), Effect.provide(secretStoreLayer(values))),
  );

describe("RedactionServiceLive", () => {
  test("tag is importable and forProfile yields a Redactor", async () => {
    const redactor = await runWithStore(
      Effect.flatMap(RedactionService, (service) => service.forProfile("secrets")),
      {},
    );

    expect(typeof (redactor satisfies Redactor).redactString).toBe("function");
    expect(typeof redactor.redactValue).toBe("function");
  });

  test("masks resolved SecretStore values", async () => {
    const redactor = await runWithStore(
      Effect.flatMap(RedactionService, (service) => service.forProfile("secrets")),
      { FOO: "supersecret" },
    );

    const redacted = redactor.redactString("x supersecret y");
    expect(redacted).toContain("[redacted]");
    expect(redacted).not.toContain("supersecret");
  });

  test("resolves secrets at call time rather than layer build time", async () => {
    let listReads = 0;
    let getReads = 0;
    const store = {
      id: "counting",
      get: () => {
        getReads += 1;
        return Effect.succeed("latersecret");
      },
      has: () => Effect.succeed(true),
      list: Effect.sync(() => {
        listReads += 1;
        return ["LATER"];
      }),
    } satisfies SecretStore.Service;

    const program = Effect.gen(function* () {
      const service = yield* RedactionService;
      expect(listReads).toBe(0);
      expect(getReads).toBe(0);
      const redactor = yield* service.forProfile("secrets");
      expect(redactor.redactString("latersecret")).toContain("[redacted]");
      return { listReads, getReads };
    });

    const counts = await Effect.runPromise(
      program.pipe(Effect.provide(RedactionServiceLive), Effect.provide(Layer.succeed(SecretStore, store))),
    );
    expect(counts).toEqual({ listReads: 1, getReads: 1 });
  });

  test("ignores SecretNotFoundError races for listed ids", async () => {
    const store = {
      id: "racy",
      get: (secret: string) =>
        secret === "MISSING"
          ? Effect.fail(new SecretNotFoundError({ secret, message: "missing" }))
          : Effect.succeed("stillsecret"),
      has: () => Effect.succeed(true),
      list: Effect.succeed(["MISSING", "PRESENT"]),
    } satisfies SecretStore.Service;

    const redactor = await Effect.runPromise(
      Effect.flatMap(RedactionService, (service) => service.forProfile("secrets")).pipe(
        Effect.provide(RedactionServiceLive),
        Effect.provide(Layer.succeed(SecretStore, store)),
      ),
    );

    expect(redactor.redactString("stillsecret")).toContain("[redacted]");
  });

  test("masks explicit redaction tokens", async () => {
    const redactor = await runWithStore(
      Effect.flatMap(RedactionService, (service) =>
        service.forProfile("secrets", { redactionTokens: ["tok123"] }),
      ),
      {},
    );

    expect(redactor.redactString("value tok123")).toBe("value [redacted]");
  });

  test("masks proxy URL userinfo credentials", async () => {
    const redactor = await runWithStore(
      Effect.flatMap(RedactionService, (service) =>
        service.forProfile("secrets", { proxyUrls: ["http://user:pw@proxy:3128"] }),
      ),
      {},
    );

    const redacted = redactor.redactString("proxy user pw");
    expect(redacted).not.toContain("user");
    expect(redacted).not.toContain("pw");
    expect(redacted).toContain("[redacted]");
  });

  test("forwards transcript env options", async () => {
    const redactor = await runWithStore(
      Effect.flatMap(RedactionService, (service) =>
        service.forProfile("transcript", { transcriptEnv: { home: "/home/me" } }),
      ),
      {},
    );

    expect(redactor.redactString("/home/me/x")).toContain("<HOME>");
  });
});
