import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import {
  dockerCapabilitiesForHost,
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

  test("classifies Docker host bind mount performance", () => {
    expect(dockerCapabilitiesForHost("linux", "/var/run/docker.sock").bindMountPerformance).toBe("native");
    expect(
      dockerCapabilitiesForHost("linux", "/home/alice/.docker/desktop/docker.sock").bindMountPerformance,
    ).toBe("slow");
    expect(dockerCapabilitiesForHost("linux", "tcp://127.0.0.1:2375").bindMountPerformance).toBe("slow");
    expect(dockerCapabilitiesForHost("darwin", "/var/run/docker.sock").bindMountPerformance).toBe("slow");
  });

  test("introspects platform-specific Docker capabilities after API discovery", async () => {
    const linuxProvider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({ platform: "linux", env: {}, dockerApi: { info: Effect.succeed({}) } }),
        ),
      ),
    );
    const macosProvider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({ platform: "darwin", env: {}, dockerApi: { info: Effect.succeed({}) } }),
        ),
      ),
    );

    expect(linuxProvider.capabilities).toEqual(linuxDockerCapabilities);
    expect(macosProvider.capabilities).toEqual(macosDockerCapabilities);
  });

  test("uses resolved Docker hosts for API creation and capabilities", async () => {
    const createdHosts: Array<string> = [];
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            platform: "linux",
            env: {},
            dockerApiFactory: (dockerHost) => {
              createdHosts.push(dockerHost);
              return { info: Effect.succeed({}) };
            },
          }),
        ),
      ),
    );
    const desktopProvider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            platform: "linux",
            env: { HOME: "/home/alice", LANDO_DOCKER_DESKTOP: "1" },
            dockerApiFactory: (dockerHost) => {
              createdHosts.push(dockerHost);
              return { info: Effect.succeed({}) };
            },
          }),
        ),
      ),
    );

    expect(createdHosts).toEqual(["/var/run/docker.sock", "/home/alice/.docker/desktop/docker.sock"]);
    expect(provider.capabilities.bindMountPerformance).toBe("native");
    expect(desktopProvider.capabilities.bindMountPerformance).toBe("slow");
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
