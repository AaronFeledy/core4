import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { CI_MINIMUM_PODMAN_VERSION, podmanVersionAssertScript } from "./ci-podman-install.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");

const workflowPaths = [
  ".github/workflows/ci.yml",
  ".github/workflows/nightly.yml",
  ".github/workflows/provider-matrix.yml",
] as const;

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

describe("generated workflows carry the Podman 6 host contract", () => {
  for (const path of workflowPaths) {
    test(`${path} installs Podman 6 and asserts the floor before Podman-backed steps`, async () => {
      const contents = await Bun.file(join(REPO_ROOT, path)).text();
      expect(contents).not.toContain("apt-get install -y podman");
      expect(contents).toContain("brew install podman");
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
});
