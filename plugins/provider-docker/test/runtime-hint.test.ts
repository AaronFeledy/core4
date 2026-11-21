import { describe, expect, test } from "bun:test";

import { isVmMediatedDockerHost } from "../src/index.ts";
import { runtimeHintForEndpoint, unreachableDockerRemediation } from "../src/runtime-hint.ts";

describe("runtimeHintForEndpoint", () => {
  test("classifies Colima sockets and start commands", () => {
    expect(runtimeHintForEndpoint("/home/alice/.colima/default/docker.sock")).toEqual({
      id: "colima",
      runtime: "Colima",
      startCommand: "colima start",
      vmMediated: true,
    });
    expect(runtimeHintForEndpoint("unix:///Users/alice/.colima/work/docker.sock")).toMatchObject({
      id: "colima",
      startCommand: "colima start --profile work",
    });
  });

  test("classifies Lima, OrbStack, and Rancher Desktop sockets", () => {
    expect(runtimeHintForEndpoint("/home/alice/.lima/default/sock/docker.sock")).toEqual({
      id: "lima",
      runtime: "Lima",
      startCommand: "limactl start default",
      vmMediated: true,
    });
    expect(runtimeHintForEndpoint("/home/alice/.orbstack/run/docker.sock")).toEqual({
      id: "orbstack",
      runtime: "OrbStack",
      startCommand: "orb start",
      vmMediated: true,
    });
    expect(runtimeHintForEndpoint("/home/alice/.rd/docker.sock")).toEqual({
      id: "rancher-desktop",
      runtime: "Rancher Desktop",
      vmMediated: true,
    });
  });

  test("classifies Docker Desktop run and desktop sockets", () => {
    expect(runtimeHintForEndpoint("/home/alice/.docker/desktop/docker.sock")).toMatchObject({
      id: "docker-desktop",
      runtime: "Docker Desktop",
      vmMediated: true,
    });
    expect(runtimeHintForEndpoint("/home/alice/.docker/run/docker.sock")).toMatchObject({
      id: "docker-desktop",
    });
  });

  test("classifies the Linux engine and rootless sockets", () => {
    expect(runtimeHintForEndpoint("/var/run/docker.sock")).toEqual({
      id: "linux-engine",
      runtime: "Docker Engine",
      startCommand: "sudo systemctl start docker",
      vmMediated: false,
    });
    expect(runtimeHintForEndpoint("unix:///run/user/1000/docker.sock")).toEqual({
      id: "rootless",
      runtime: "rootless Docker",
      startCommand: "systemctl --user start docker",
      vmMediated: false,
    });
  });

  test("returns undefined for an unrecognized endpoint", () => {
    expect(runtimeHintForEndpoint("tcp://127.0.0.1:2375")).toBeUndefined();
    expect(runtimeHintForEndpoint("/tmp/custom.sock")).toBeUndefined();
  });
});

describe("isVmMediatedDockerHost", () => {
  test("treats Linux VM runtime sockets as VM-mediated", () => {
    expect(isVmMediatedDockerHost("linux", "/home/alice/.colima/default/docker.sock")).toBe(true);
    expect(isVmMediatedDockerHost("linux", "/home/alice/.lima/default/sock/docker.sock")).toBe(true);
    expect(isVmMediatedDockerHost("linux", "/home/alice/.orbstack/run/docker.sock")).toBe(true);
    expect(isVmMediatedDockerHost("linux", "/home/alice/.rd/docker.sock")).toBe(true);
    expect(isVmMediatedDockerHost("linux", "/home/alice/.docker/desktop/docker.sock")).toBe(true);
  });

  test("does not treat local Linux engine sockets as VM-mediated", () => {
    expect(isVmMediatedDockerHost("linux", "/var/run/docker.sock")).toBe(false);
    expect(isVmMediatedDockerHost("linux", "unix:///run/user/1000/docker.sock")).toBe(false);
    expect(isVmMediatedDockerHost("wsl", "/var/run/docker.sock")).toBe(false);
  });

  test("keeps Darwin VM-mediated regardless of socket path", () => {
    expect(isVmMediatedDockerHost("darwin", "/var/run/docker.sock")).toBe(true);
    expect(isVmMediatedDockerHost("darwin", "/home/alice/.colima/default/docker.sock")).toBe(true);
  });
});

describe("unreachable Docker remediation", () => {
  test("names Colima when that endpoint is unreachable", () => {
    const remediation = unreachableDockerRemediation("/home/alice/.colima/default/docker.sock", "linux");
    expect(remediation).toContain("Start Colima (`colima start`)");
    expect(remediation).toContain("lando doctor --provider=docker");
  });

  test("names the Linux engine on /var/run/docker.sock", () => {
    const remediation = unreachableDockerRemediation("/var/run/docker.sock", "linux");
    expect(remediation).toContain("sudo systemctl start docker");
    expect(remediation).toContain("lando doctor --provider=docker");
  });

  test("does not suggest systemctl for Darwin /var/run/docker.sock", () => {
    const remediation = unreachableDockerRemediation("/var/run/docker.sock", "darwin");
    expect(remediation).toContain("Start Docker Desktop or Docker Engine");
    expect(remediation).not.toContain("systemctl");
    expect(remediation).toContain("lando doctor --provider=docker");
  });
});
