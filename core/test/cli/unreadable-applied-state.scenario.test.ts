import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { appIdentityKey } from "@lando/sdk/schema";

const cliEntry = resolve(import.meta.dir, "../../bin/lando.ts");

const withIsolatedState = async (use: (root: string, env: NodeJS.ProcessEnv) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "lando-unreadable-cli-"));
  const data = join(root, "data");
  const applied = join(data, "plugins/@lando/provider-lando/applied-plans");
  await mkdir(applied, { recursive: true });
  await writeFile(join(applied, "damaged-a.json"), "unreadable applied state", { mode: 0o600 });
  const podman = join(data, "plugins/@lando/provider-podman");
  await mkdir(podman, { recursive: true });
  await writeFile(join(podman, "applied-plans.json"), "unreadable aggregate state", { mode: 0o600 });
  try {
    await use(root, {
      ...process.env,
      LANDO_USER_DATA_ROOT: data,
      LANDO_USER_CACHE_ROOT: join(root, "cache"),
      LANDO_USER_CONFIG_ROOT: join(root, "config"),
      LANDO_USER_STATE_ROOT: join(root, "state"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

for (const command of ["info", "logs", "stop", "destroy"] as const) {
  test(`${command} outside an app preserves LandofileNotFound with unrelated unreadable state in isolated roots`, async () => {
    await withIsolatedState(async (root, env) => {
      const proc = Bun.spawn(
        [process.execPath, cliEntry, command, "--format=json", ...(command === "destroy" ? ["--yes"] : [])],
        { cwd: root, env, stdout: "pipe", stderr: "pipe" },
      );
      const [exit, stdout] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(exit).toBe(1);
      expect(stdout).toContain("LandofileNotFoundError");
      expect(stdout).not.toContain("applied-state.read");
    });
  });
}

test("info reads app B while app A and another provider's aggregate state are unreadable", async () => {
  await withIsolatedState(async (root, env) => {
    const appRoot = join(root, "app-b");
    await mkdir(appRoot);
    await writeFile(join(appRoot, ".lando.yml"), "name: readable-b\nservices: {}\n");
    const applied = join(root, "data/plugins/@lando/provider-docker/applied-plans");
    await mkdir(applied, { recursive: true });
    await writeFile(
      join(applied, "readable-b.json"),
      JSON.stringify({
        version: 2,
        data: {
          id: "readable-b",
          name: "readable-b",
          slug: "readable-b",
          root: appRoot,
          provider: "docker",
          identity: { appRoot, ownerKey: appIdentityKey("owner", appRoot) },
          services: {},
          routes: [],
          stores: [],
          fileSync: [],
          extensions: {},
          metadata: { resolvedAt: "2026-10-26T00:00:00.000Z", source: "isolated-cli", runtime: 4 },
        },
      }),
      { mode: 0o600 },
    );
    const proc = Bun.spawn([process.execPath, cliEntry, "info", "--format=json"], {
      cwd: appRoot,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(stdout).toContain("readable-b");
  });
});

for (const command of ["stop", "destroy"] as const) {
  test(`${command} refuses app A's unreadable receipt even without runtime resources`, async () => {
    await withIsolatedState(async (root, env) => {
      const appRoot = join(root, "app-a");
      await mkdir(appRoot);
      await writeFile(join(appRoot, ".lando.yml"), "name: damaged-a\nservices: {}\n");
      const proc = Bun.spawn(
        [process.execPath, cliEntry, command, "--format=json", ...(command === "destroy" ? ["--yes"] : [])],
        { cwd: appRoot, env, stdout: "pipe", stderr: "pipe" },
      );
      const [exit, stdout] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(exit).toBe(1);
      expect(stdout).toContain("applied-state.read");
      expect(stdout).toContain("damaged-a.json");
    });
  });
}
