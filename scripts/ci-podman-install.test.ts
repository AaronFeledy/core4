import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  CI_MINIMUM_PODMAN_VERSION,
  podmanVersionAssertScript,
  renderInstallPodman6Step,
} from "./ci-podman-install.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");

const workflowPaths = [".github/workflows/nightly.yml", ".github/workflows/provider-matrix.yml"] as const;

const installPodman6Script = renderInstallPodman6Step()
  .split("\n")
  .slice(2)
  .map((line) => line.replace(/^ {10}/, ""))
  .join("\n");

const containerConfigSeedScript = installPodman6Script.slice(
  installPodman6Script.indexOf('mkdir -p "$HOME/.config/containers"'),
  installPodman6Script.indexOf("podman --version"),
);

let shimDir: string;

beforeEach(async () => {
  shimDir = await mkdtemp(join(tmpdir(), "podman-shim-"));
});

afterEach(async () => {
  await rm(shimDir, { recursive: true, force: true });
});

const runAssertWithPodmanOutput = async (versionOutput: string | undefined): Promise<number> => {
  const shim = join(shimDir, "podman");
  if (versionOutput === undefined) {
    // Simulate a missing podman deterministically: a shim that fails like an
    // absent command, so a real host podman on PATH can never leak in.
    await writeFile(shim, "#!/bin/sh\nexit 127\n");
  } else {
    await writeFile(shim, `#!/bin/sh\nprintf '%s\\n' "${versionOutput}"\n`);
  }
  await chmod(shim, 0o755);
  const proc = Bun.spawnSync(["bash", "-c", podmanVersionAssertScript], {
    env: { ...process.env, PATH: `${shimDir}:/usr/bin:/bin` },
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.exitCode;
};

describe("podman version assert script", () => {
  test("minimum version is the Podman 6 floor", () => {
    expect(CI_MINIMUM_PODMAN_VERSION).toBe("6.0.0");
  });

  test("rejects versions below the floor with remediation", async () => {
    expect(await runAssertWithPodmanOutput("podman version 4.9.3")).not.toBe(0);
    expect(await runAssertWithPodmanOutput("podman version 5.4.2")).not.toBe(0);
  });

  test("compares tuple-wise, not as packed integers", async () => {
    expect(await runAssertWithPodmanOutput("podman version 5.1000.0")).not.toBe(0);
    expect(await runAssertWithPodmanOutput("podman version 5.0.9999999")).not.toBe(0);
    expect(await runAssertWithPodmanOutput("podman version 6.08.0")).toBe(0);
  });

  test("accepts the floor and above, ignoring pre-release suffixes", async () => {
    expect(await runAssertWithPodmanOutput("podman version 6.0.0")).toBe(0);
    expect(await runAssertWithPodmanOutput("podman version 6.1.0-rc1")).toBe(0);
    expect(await runAssertWithPodmanOutput("podman version 10.0.0")).toBe(0);
  });

  test("fails closed on unparseable or missing podman", async () => {
    expect(await runAssertWithPodmanOutput("not a version")).not.toBe(0);
    expect(await runAssertWithPodmanOutput(undefined)).not.toBe(0);
  });

  test("prints remediation naming the floor on failure", async () => {
    const shim = join(shimDir, "podman");
    await writeFile(shim, `#!/bin/sh\nprintf 'podman version 5.4.2\\n'\n`);
    await chmod(shim, 0o755);
    const proc = Bun.spawnSync(["bash", "-c", podmanVersionAssertScript], {
      env: { ...process.env, PATH: `${shimDir}:/usr/bin:/bin` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = `${proc.stdout.toString()}${proc.stderr.toString()}`;
    expect(output).toContain("Install Podman >= 6.0.0");
  });
});

describe("Podman user container configuration", () => {
  test("guards containers.conf and pins both cgroup manager branches explicitly", () => {
    const guardIndex = installPodman6Script.indexOf(
      'if ! test -f "$HOME/.config/containers/containers.conf"; then',
    );
    const systemdIndex = installPodman6Script.indexOf(
      `printf '[engine]\\ncgroup_manager = "systemd"\\n' > "$HOME/.config/containers/containers.conf"`,
    );
    const cgroupfsIndex = installPodman6Script.indexOf(
      `printf '[engine]\\ncgroup_manager = "cgroupfs"\\n' > "$HOME/.config/containers/containers.conf"`,
    );

    expect(guardIndex).toBeGreaterThan(0);
    expect(installPodman6Script).toContain("if test -d /run/systemd/system; then");
    expect(systemdIndex).toBeGreaterThan(guardIndex);
    expect(cgroupfsIndex).toBeGreaterThan(systemdIndex);
  });

  test("seeds the host-appropriate explicit cgroup manager in a fresh HOME", async () => {
    const home = join(shimDir, "home");
    await mkdir(home, { recursive: true });

    const proc = Bun.spawnSync(["bash", "-c", containerConfigSeedScript], {
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const usesSystemd = Bun.spawnSync(["test", "-d", "/run/systemd/system"]).exitCode === 0;

    expect(proc.exitCode).toBe(0);
    expect(await Bun.file(join(home, ".config/containers/containers.conf")).text()).toBe(
      `[engine]\ncgroup_manager = "${usesSystemd ? "systemd" : "cgroupfs"}"\n`,
    );
  });

  test("preserves an existing containers.conf", async () => {
    const home = join(shimDir, "home");
    const configPath = join(home, ".config/containers/containers.conf");
    await mkdir(join(home, ".config/containers"), { recursive: true });
    await writeFile(configPath, "existing config\n");

    const proc = Bun.spawnSync(["bash", "-c", containerConfigSeedScript], {
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(proc.exitCode).toBe(0);
    expect(await Bun.file(configPath).text()).toBe("existing config\n");
  });
});

describe("generated workflows carry the Podman 6 host contract", () => {
  for (const path of workflowPaths) {
    test(`${path} installs Podman 6 and asserts the floor before Podman-backed steps`, async () => {
      const contents = await Bun.file(join(REPO_ROOT, path)).text();
      expect(contents).not.toContain("apt-get install -y podman");
      expect(contents).toContain("brew update\n          brew install podman");
      const assertIndex = contents.indexOf("Assert Podman 6 host contract");
      expect(assertIndex).toBeGreaterThan(0);
      const podmanUseMarkers =
        path === ".github/workflows/provider-matrix.yml"
          ? ["podman system service"]
          : ["podman system service", "lando setup"];
      const firstPodmanUse = Math.min(
        ...podmanUseMarkers.map((marker) => contents.indexOf(marker)).filter((index) => index >= 0),
      );
      expect(firstPodmanUse).toBeGreaterThan(0);
      expect(assertIndex).toBeLessThan(firstPodmanUse);
    });
  }

  for (const path of workflowPaths) {
    test(`${path} pins the user-level cgroup manager`, async () => {
      const contents = await Bun.file(join(REPO_ROOT, path)).text();
      expect(contents).toContain('if ! test -f "$HOME/.config/containers/containers.conf"; then');
      expect(contents).toContain('cgroup_manager = "systemd"');
      expect(contents).toContain('cgroup_manager = "cgroupfs"');
    });
  }
});
