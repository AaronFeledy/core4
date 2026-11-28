import { describe, expect, test } from "bun:test";
import {
  dockerApiVersionUnavailable,
  negotiateDockerApiVersion,
} from "@lando/container-runtime/docker/api-version";
import { layer as makeProviderLayer } from "@lando/provider-docker";
import { RuntimeProvider } from "@lando/sdk/services";
import { Effect } from "effect";

describe("provider-docker isAvailable", () => {
  test("reports available when the Docker daemon responds to /info", async () => {
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({ platform: "linux", env: {}, dockerApi: { info: Effect.succeed({}) } }),
        ),
      ),
    );
    expect(await Effect.runPromise(provider.isAvailable)).toBe(true);
  });

  test("reports unavailable when the Docker daemon socket is unreachable", async () => {
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            platform: "linux",
            env: {},
            dockerHost: "/nonexistent/lando-docker-test.sock",
          }),
        ),
      ),
    );
    expect(await Effect.runPromise(provider.isAvailable)).toBe(false);
  });

  test("fails with both version ranges when the daemon API is incompatible", async () => {
    const negotiation = negotiateDockerApiVersion({ minApiVersion: "1.50", apiVersion: "1.55" });
    if (negotiation.ok) throw new Error("expected incompatible daemon range");
    const versionError = dockerApiVersionUnavailable(
      { providerId: "docker", remediation: "Start Docker.", env: {} },
      negotiation,
    );
    let infoCalls = 0;
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            platform: "linux",
            env: {},
            dockerApi: {
              info: Effect.suspend(() => {
                infoCalls += 1;
                return infoCalls === 1 ? Effect.succeed({}) : Effect.fail(versionError);
              }),
            },
          }),
        ),
      ),
    );
    const availability = await Effect.runPromise(provider.isAvailable.pipe(Effect.flip));
    expect(availability.message).toContain("1.43-1.44");
    expect(availability.message).toContain("1.50-1.55");
    const status = await Effect.runPromise(provider.getStatus.pipe(Effect.flip));
    expect(status._tag).toBe("ProviderUnavailableError");
    expect(status.message).toContain("1.43-1.44");
    expect(status.message).toContain("1.50-1.55");
    expect(status.remediation).toContain("DOCKER_API_VERSION");
  });

  test("an operation that cannot connect names the runtime to start", async () => {
    // Given a Colima socket that does not exist, reached through the real transport
    const dockerHost = `/tmp/lando-${process.pid}-absent/.colima/default/docker.sock`;
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(Effect.provide(makeProviderLayer({ platform: "darwin", env: {}, dockerHost }))),
    );

    // When
    const inspect = provider.inspectResourceNames?.({ kind: "volume", limit: 1 });
    if (inspect === undefined) throw new Error("docker provider has no resource inspector");
    const failures = await Promise.all([
      Effect.runPromise(Effect.flip(provider.getStatus)),
      Effect.runPromise(Effect.flip(inspect)),
    ]);

    // Then
    for (const error of failures) {
      expect(error._tag).toBe("ProviderUnavailableError");
      expect(error.remediation).toStartWith("Start Colima (`colima start`)");
    }
  });
});
