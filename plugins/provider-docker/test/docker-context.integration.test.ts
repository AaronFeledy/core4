import { afterEach, describe, expect, test } from "bun:test";
import { makeRuntimeProvider } from "@lando/provider-docker";
import { Effect } from "effect";

import { dockerConfig, removeDockerConfigs } from "./support/docker-config.ts";

const socket = process.env.LANDO_TEST_DOCKER_SOCKET;
const platform = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
// A context names a socket with its scheme, the way `docker context create` writes it.
const contextHost = socket?.startsWith("/") === true ? `unix://${socket}` : (socket ?? "");

afterEach(removeDockerConfigs);

describe("docker provider through a Docker CLI context", () => {
  test.skipIf(socket === undefined)(
    "reaches the engine its current context names, with no DOCKER_HOST",
    async () => {
      const config = dockerConfig()
        .context("lando-ci", { Host: contextHost, SkipTLSVerify: false })
        .current("lando-ci");

      const provider = await Effect.runPromise(
        makeRuntimeProvider({ platform, env: { DOCKER_CONFIG: config.dir } }),
      );

      expect(await Effect.runPromise(provider.isAvailable)).toBe(true);
      expect(await Effect.runPromise(provider.getStatus)).toMatchObject({ state: "running" });
      const inspect = provider.inspectResourceNames?.({ kind: "volume", limit: 1 });
      if (inspect === undefined) throw new Error("docker provider has no resource inspector");
      expect(Array.isArray(await Effect.runPromise(inspect))).toBe(true);
    },
  );
});
