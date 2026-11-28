import { describe, expect, test } from "bun:test";

import { dockerCapabilitiesForHost } from "../src/index.ts";
import { unreachableDockerRemediation } from "../src/runtime-hint.ts";

describe("unreachable Docker remediation", () => {
  test.each([
    ["/Users/alice/.colima/default/docker.sock", "darwin", "Start Colima (`colima start`)"],
    [
      "unix:///Users/alice/.colima/work/docker.sock",
      "darwin",
      "Start Colima (`colima start --profile work`)",
    ],
    ["/Users/alice/.lima/docker/sock/docker.sock", "darwin", "Start Lima (`limactl start docker`)"],
    ["unix:///Users/alice/.orbstack/run/docker.sock", "darwin", "Start OrbStack (`orb start`)"],
    ["/Users/alice/.rd/docker.sock", "darwin", "Start Rancher Desktop, then retry"],
    ["unix:///home/alice/.docker/desktop/docker.sock", "linux", "Start Docker Desktop, then retry"],
    ["unix:///run/user/1000/docker.sock", "linux", "Start rootless Docker (`systemctl --user start docker`)"],
    ["/var/run/docker.sock", "linux", "Start Docker Engine (`sudo systemctl start docker`)"],
  ] as const)("names the runtime that publishes %s on %s", (endpoint, platform, start) => {
    const remediation = unreachableDockerRemediation(endpoint, platform);
    expect(remediation.startsWith(start)).toBe(true);
    expect(remediation).toContain("lando doctor --provider=docker");
  });

  test.each([
    ["/var/run/docker.sock", "darwin"],
    ["/var/run/docker.sock", "wsl"],
    ["tcp://127.0.0.1:2375", "linux"],
    ["/tmp/custom.sock", "linux"],
  ] as const)("does not guess a runtime for %s on %s", (endpoint, platform) => {
    const remediation = unreachableDockerRemediation(endpoint, platform);
    expect(remediation.startsWith("Start Docker Desktop or Docker Engine")).toBe(true);
    expect(remediation).not.toContain("systemctl");
  });

  test("never repeats the endpoint, which can carry credentials", () => {
    expect(unreachableDockerRemediation("tcp://alice:s3cret@build.example:2375", "linux")).not.toContain(
      "s3cret",
    );
  });
});

describe("Linux bind performance by Docker runtime", () => {
  test.each([
    "/home/alice/.colima/default/docker.sock",
    "/home/alice/.lima/docker/sock/docker.sock",
    "/home/alice/.rd/docker.sock",
    "/home/alice/.docker/desktop/docker.sock",
  ])("reports slow binds for the VM behind %s", (endpoint) => {
    expect(dockerCapabilitiesForHost("linux", endpoint).bindMountPerformance).toBe("slow");
  });

  test.each(["/var/run/docker.sock", "unix:///run/user/1000/docker.sock"])(
    "reports native binds for the local engine behind %s",
    (endpoint) => {
      expect(dockerCapabilitiesForHost("linux", endpoint).bindMountPerformance).toBe("native");
    },
  );
});
