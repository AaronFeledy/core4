import { afterEach, describe, expect, test } from "bun:test";
import type { PluginDoctorCheckInput } from "@lando/sdk/plugins";
import { PluginDoctorReport } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";

import { plugin } from "../src/index.ts";
import { dockerConfig, removeDockerConfigs } from "./support/docker-config.ts";

afterEach(removeDockerConfigs);

const endpointCheck = () => {
  const check = plugin.doctorChecks?.find((candidate) => candidate.id === "docker-endpoint");
  if (check === undefined) throw new Error("docker-endpoint check is not contributed");
  return check;
};

const run = (env: Record<string, string | undefined>, providerId = "docker") => {
  const input: PluginDoctorCheckInput = {
    providerId,
    platform: "linux",
    env,
    userDataRoot: undefined,
    binDir: undefined,
    stateDir: undefined,
  };
  return Effect.runPromise(endpointCheck().run(input));
};

const decodes = (report: unknown) =>
  Schema.decodeUnknownResult(PluginDoctorReport, { onExcessProperty: "error" })(report)._tag === "Success";

describe("docker-endpoint doctor check", () => {
  test("reports nothing when another provider is selected", async () => {
    expect(await run({}, "lando")).toEqual([]);
  });

  test("reports the endpoint and the environment source that chose it", async () => {
    const [report] = await run({ DOCKER_HOST: "unix:///tmp/docker.sock" });
    expect(report).toMatchObject({
      status: "pass",
      context: { endpoint: "unix:///tmp/docker.sock", source: "DOCKER_HOST" },
    });
    expect(decodes(report)).toBe(true);
  });

  test("names the active Docker context", async () => {
    const config = dockerConfig()
      .context("colima", { Host: "unix:///home/alice/.colima/default/docker.sock" })
      .current("colima");
    const [report] = await run({ DOCKER_CONFIG: config.dir });
    expect(report).toMatchObject({
      status: "pass",
      runtimeStatus: "unix:///home/alice/.colima/default/docker.sock (Docker context colima)",
      context: {
        endpoint: "unix:///home/alice/.colima/default/docker.sock",
        source: "context",
        contextName: "colima",
      },
    });
    expect(decodes(report)).toBe(true);
  });

  test("fails with remediation when the active context uses TLS", async () => {
    const config = dockerConfig()
      .context("remote", { Host: "tcp://remote.example:2376" }, ["ca.pem", "cert.pem", "key.pem"])
      .current("remote");
    const [report] = await run({ DOCKER_CONFIG: config.dir });
    expect(report).toMatchObject({
      status: "fail",
      severity: "error",
      context: { source: "context", contextName: "remote", reason: "tls" },
    });
    expect(report?.solutions[0]?.description).toContain("docker context use");
    expect(decodes(report)).toBe(true);
  });
});
