import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { dockerApiVersionUnavailable, negotiateDockerApiVersion } from "@lando/container-runtime/docker/api-version";
import { layer as makeProviderLayer } from "@lando/provider-docker";
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

  test("fails with both version ranges when the daemon API is incompatible", async () => {
    const negotiation = negotiateDockerApiVersion({ minApiVersion: "1.50", apiVersion: "1.55" });
    if (negotiation.ok) throw new Error("expected incompatible daemon range");
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            platform: "linux",
            dockerApi: {
              info: Effect.fail(
                dockerApiVersionUnavailable(
                  { providerId: "docker", remediation: "Start Docker." },
                  negotiation,
                ),
              ),
            },
          }),
        ),
      ),
    );
    const availability = await Effect.runPromise(provider.isAvailable.pipe(Effect.flip));
    expect(availability.message).toContain("1.43-1.44");
    expect(availability.message).toContain("1.50-1.55");
    const status = await Effect.runPromise(provider.getStatus);
    expect(status.running).toBe(false);
    expect(status.message).toContain("1.43-1.44");
    expect(status.message).toContain("1.50-1.55");
  });
});
