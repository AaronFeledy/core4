import { describe, expect, test } from "bun:test";
import { layer as makeProviderLayer } from "@lando/provider-podman";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { RuntimeProvider } from "@lando/sdk/services";
import { Effect } from "effect";
import { withPing } from "./podman-api-fixtures.ts";

describe("provider-podman isAvailable", () => {
  test("getStatus fails with the ping failure instead of claiming the provider is running", async () => {
    const failure = new ProviderUnavailableError({
      providerId: "podman",
      operation: "ping",
      message: "Podman stopped answering.",
      remediation: "Start the Podman API service.",
    });
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            platform: "linux",
            podmanApi: {
              info: Effect.succeed({ version: { Version: "6.0.2" } }),
              ping: Effect.fail(failure),
            },
          }),
        ),
      ),
    );
    const status = await Effect.runPromise(Effect.result(provider.getStatus));
    expect(status).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "ProviderUnavailableError",
        operation: "getStatus",
        message: failure.message,
        remediation:
          "Start the Podman API service, verify access to the configured Podman socket, then retry the command.",
        cause: failure,
      },
    });
  });
  test("reports available when the Podman API responds to /info", async () => {
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            platform: "linux",
            podmanApi: withPing({ info: Effect.succeed({ version: { Version: "6.0.2" } }) }),
          }),
        ),
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
            podmanApi: withPing({
              info: Effect.sync(() => {
                infoCalls += 1;
                return infoCalls;
              }).pipe(
                Effect.flatMap((call) =>
                  call === 1
                    ? Effect.succeed({ version: { Version: "6.0.2" } })
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
            }),
          }),
        ),
      ),
    );
    expect(await Effect.runPromise(provider.isAvailable)).toBe(false);
  });
});
