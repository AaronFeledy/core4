import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import {
  dockerCapabilitiesForPlatform,
  linuxDockerCapabilities,
  macosDockerCapabilities,
  makeProviderLayer,
  resolveDockerHost,
} from "@lando/provider-docker";
import { ProviderCapabilities } from "@lando/sdk/schema";
import { RuntimeProvider } from "@lando/sdk/services";

describe("provider-docker capabilities", () => {
  test("declares every ProviderCapabilities field for Linux and macOS", () => {
    const expectedFields = Object.keys(ProviderCapabilities.fields).sort();
    const linux = dockerCapabilitiesForPlatform("linux");
    const macos = dockerCapabilitiesForPlatform("darwin");

    expect(Object.keys(linux).sort()).toEqual(expectedFields);
    expect(Object.keys(macos).sort()).toEqual(expectedFields);
    expect(linux.bindMountPerformance).toBe("native");
    expect(macos.bindMountPerformance).toBe("slow");
    expect(macos.bindMounts).toBe(true);
  });

  test("introspects platform-specific Docker capabilities after API discovery", async () => {
    const linuxProvider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(makeProviderLayer({ platform: "linux", dockerApi: { info: Effect.succeed({}) } })),
      ),
    );
    const macosProvider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(makeProviderLayer({ platform: "darwin", dockerApi: { info: Effect.succeed({}) } })),
      ),
    );

    expect(linuxProvider.capabilities).toEqual(linuxDockerCapabilities);
    expect(macosProvider.capabilities).toEqual(macosDockerCapabilities);
  });

  test("supports explicit config and env Docker host discovery", () => {
    expect(resolveDockerHost({ dockerHost: "tcp://127.0.0.1:2375", env: {}, platform: "linux" })).toBe(
      "tcp://127.0.0.1:2375",
    );
    expect(
      resolveDockerHost({ env: { LANDO_TEST_DOCKER_SOCKET: "/tmp/docker.sock" }, platform: "linux" }),
    ).toBe("/tmp/docker.sock");
    expect(resolveDockerHost({ env: { DOCKER_HOST: "unix:///tmp/docker.sock" }, platform: "linux" })).toBe(
      "unix:///tmp/docker.sock",
    );
    expect(
      resolveDockerHost({ env: { HOME: "/home/alice", LANDO_DOCKER_DESKTOP: "1" }, platform: "linux" }),
    ).toBe("/home/alice/.docker/desktop/docker.sock");
    expect(resolveDockerHost({ env: {}, platform: "darwin" })).toBe("/var/run/docker.sock");
  });
});
