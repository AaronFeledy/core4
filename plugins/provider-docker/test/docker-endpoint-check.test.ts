import { describe, expect, test } from "bun:test";
import type { PluginDoctorCheckInput } from "@lando/sdk/plugins";
import { PluginDoctorReport } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";

import { type DockerContextFileReader, dockerContextMetaPath } from "../src/docker-context.ts";
import { makeDockerEndpointCheck } from "../src/docker-endpoint-check.ts";

const CONFIG_DIR = "/tmp/lando-docker-config";

const files = (entries: Record<string, string>): DockerContextFileReader => {
  const store = new Map(Object.entries(entries));
  return (path) => store.get(path);
};

const input = (env: Record<string, string | undefined>, providerId = "docker"): PluginDoctorCheckInput => ({
  providerId,
  platform: "linux",
  env,
  userDataRoot: undefined,
  binDir: undefined,
  stateDir: undefined,
});

const run = (
  env: Record<string, string | undefined>,
  readFile: DockerContextFileReader,
  providerId = "docker",
) => Effect.runPromise(makeDockerEndpointCheck(readFile).run(input(env, providerId)));

describe("docker-endpoint doctor check", () => {
  test("skips when the selected provider is not docker", async () => {
    const reports = await run({}, files({}), "lando");
    expect(reports).toEqual([]);
  });

  test("reports the default endpoint and source", async () => {
    const reports = await run({}, files({}));
    expect(reports).toHaveLength(1);
    expect(reports[0]?.context).toEqual({
      endpoint: "/var/run/docker.sock",
      source: "default",
    });
    expect(reports[0]?.status).toBe("pass");
    expect(
      Schema.decodeUnknownResult(PluginDoctorReport, { onExcessProperty: "error" })(reports[0])._tag,
    ).toBe("Success");
  });

  test("reports a DOCKER_HOST source", async () => {
    const reports = await run({ DOCKER_HOST: "unix:///tmp/docker.sock" }, files({}));
    expect(reports[0]?.context).toEqual({
      endpoint: "unix:///tmp/docker.sock",
      source: "DOCKER_HOST",
    });
  });

  test("reports a LANDO_DOCKER_DESKTOP source", async () => {
    const reports = await run({ HOME: "/home/alice", LANDO_DOCKER_DESKTOP: "1" }, files({}));
    expect(reports[0]?.context).toEqual({
      endpoint: "/home/alice/.docker/desktop/docker.sock",
      source: "LANDO_DOCKER_DESKTOP",
    });
  });

  test("reports a context <name> source line", async () => {
    const reports = await run(
      { DOCKER_CONFIG: CONFIG_DIR, DOCKER_CONTEXT: "colima" },
      files({
        [dockerContextMetaPath(CONFIG_DIR, "colima")]: JSON.stringify({
          Endpoints: { docker: { Host: "unix:///home/alice/.colima/default/docker.sock" } },
        }),
      }),
    );
    expect(reports[0]?.context).toEqual({
      endpoint: "unix:///home/alice/.colima/default/docker.sock",
      source: "context colima",
    });
    expect(reports[0]?.runtimeStatus).toContain("context colima");
  });

  test("fails when the active context is unsupported", async () => {
    const reports = await run(
      { DOCKER_CONFIG: CONFIG_DIR, DOCKER_CONTEXT: "remote" },
      files({
        [dockerContextMetaPath(CONFIG_DIR, "remote")]: JSON.stringify({
          TLSMaterial: { docker: ["ca.pem"] },
          Endpoints: { docker: { Host: "tcp://remote.example:2376" } },
        }),
      }),
    );
    expect(reports[0]?.status).toBe("fail");
    expect(reports[0]?.context).toEqual({ contextName: "remote", reason: "tls" });
  });
});
