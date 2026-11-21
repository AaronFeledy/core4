import { describe, expect, test } from "bun:test";
import {
  dockerApiVersionUnavailable,
  negotiateDockerApiVersion,
} from "@lando/container-runtime/docker/api-version";
import { layer as makeProviderLayer } from "@lando/provider-docker";
import { ProviderUnavailableError } from "@lando/sdk/errors";
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
  });

  test("getStatus names the runtime to start when a Colima socket is unreachable", async () => {
    const unreachable = new ProviderUnavailableError({
      providerId: "docker",
      operation: "info",
      message: "engine unreachable",
      remediation: "unused",
    });
    let infoCalls = 0;
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            platform: "linux",
            dockerHost: "/home/alice/.colima/default/docker.sock",
            env: {},
            dockerApi: {
              info: Effect.suspend(() => {
                infoCalls += 1;
                return infoCalls === 1 ? Effect.succeed({}) : Effect.fail(unreachable);
              }),
            },
          }),
        ),
      ),
    );
    const status = await Effect.runPromise(provider.getStatus.pipe(Effect.flip));
    expect(status._tag).toBe("ProviderUnavailableError");
    expect(status.remediation).toContain("Start Colima (`colima start`)");
    expect(status.remediation).toContain("lando doctor --provider=docker");
  });
});
