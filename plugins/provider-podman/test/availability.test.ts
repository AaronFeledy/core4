import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { makeProviderLayer } from "@lando/provider-podman";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { RuntimeProvider } from "@lando/sdk/services";

describe("provider-podman isAvailable", () => {
  test("reports available when the Podman API responds to /info", async () => {
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(makeProviderLayer({ platform: "linux", podmanApi: { info: Effect.succeed({}) } })),
      ),
    );
    expect(await Effect.runPromise(provider.isAvailable)).toBe(true);
  });

  test("reports unavailable when the Podman API info probe fails", async () => {
    let infoCalls = 0;
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            platform: "linux",
            podmanApi: {
              info: Effect.sync(() => {
                infoCalls += 1;
                return infoCalls;
              }).pipe(
                Effect.flatMap((call) =>
                  call === 1
                    ? Effect.succeed({})
                    : Effect.fail(
                        new ProviderUnavailableError({
                          providerId: "podman",
                          operation: "podman-info",
                          message: "Podman is not reachable.",
                          remediation: "Start Podman and retry.",
                        }),
                      ),
                ),
              ),
            },
          }),
        ),
      ),
    );
    expect(await Effect.runPromise(provider.isAvailable)).toBe(false);
  });
});
