import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { makeProviderLayer } from "@lando/provider-docker";
import { RuntimeProvider } from "@lando/sdk/services";

describe("provider-docker isAvailable", () => {
  test("reports available when the Docker daemon responds to /info", async () => {
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(makeProviderLayer({ platform: "linux", dockerApi: { info: Effect.succeed({}) } })),
      ),
    );
    expect(await Effect.runPromise(provider.isAvailable)).toBe(true);
  });

  test("reports unavailable when the Docker daemon socket is unreachable", async () => {
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({ platform: "linux", dockerHost: "/nonexistent/lando-docker-test.sock" }),
        ),
      ),
    );
    expect(await Effect.runPromise(provider.isAvailable)).toBe(false);
  });
});
