import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { APPLIED_STATE_VERSION } from "@lando/container-runtime/applied-state";
import { appIdentityKey } from "@lando/sdk/schema";

const cliEntry = resolve(import.meta.dir, "../../bin/lando.ts");
const newerVersion = APPLIED_STATE_VERSION + 1;
const writtenBy = "4.15.0";
const newerRecord = JSON.stringify({ version: newerVersion, writtenBy, data: { future: true } });

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
      LANDO_USER_CONF_ROOT: join(root, "config"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("doctor reports newer applied state from disk without selecting a runtime", async () => {
  await withIsolatedState(async (root, env) => {
    const path = join(root, "data/plugins/@lando/provider-lando/applied-plans/damaged-a.json");
    await writeFile(path, newerRecord, { mode: 0o600 });
    const child = Bun.spawn(
      [process.execPath, cliEntry, "doctor", "--section", "state-compatibility", "--format=json"],
      { cwd: root, env: { ...env, LANDO_PROVIDER: "not-installed" }, stdout: "pipe", stderr: "pipe" },
    );
    const [exit, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exit).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      result: {
        checks: expect.arrayContaining([
          expect.objectContaining({
            section: "state-compatibility",
            name: "applied-state",
            status: "warn",
            context: expect.objectContaining({ reason: "newer-version", path, writtenBy }),
          }),
        ]),
      },
    });
    expect(await Bun.file(path).text()).toBe(newerRecord);
  });
});

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

test.each([false, true])(
  "info resolves the exact app with unreadable neighbors (nested: %s)",
  async (nested) => {
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
      const path = join(root, "data/plugins/@lando/provider-lando/applied-plans/damaged-a.json");
      const cwd = nested ? join(appRoot, "child") : appRoot;
      if (nested) {
        await mkdir(cwd);
        await writeFile(join(cwd, ".lando.yml"), "name: damaged-a\nprovider: lando\nservices: {}\n");
        await writeFile(path, newerRecord, { mode: 0o600 });
      }
      const proc = Bun.spawn([process.execPath, cliEntry, "info", "--format=json"], {
        cwd,
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
      expect(JSON.parse(stdout)).toMatchObject({
        result: nested
          ? { app: "damaged-a", appliedStateIssue: { reason: "newer-version", path, writtenBy } }
          : { app: "readable-b" },
      });
    });
  },
);

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

for (const { provider, record, scope } of [
  { provider: "lando", record: "applied-plans/damaged-a.json", scope: "app" },
  { provider: "podman", record: "applied-plans.json", scope: "provider" },
] as const) {
  test(`stop refuses newer ${provider} applied state without changing its bytes`, async () => {
    await withIsolatedState(async (root, env) => {
      const appRoot = join(root, "app-a");
      await mkdir(appRoot);
      await writeFile(join(appRoot, ".lando.yml"), `name: damaged-a\nprovider: ${provider}\nservices: {}\n`);
      const path = join(root, "data", "plugins", "@lando", `provider-${provider}`, record);
      const bytes = newerRecord;
      await writeFile(path, bytes, { mode: 0o600 });
      const proc = Bun.spawn([process.execPath, cliEntry, "stop", "--format=json"], {
        cwd: appRoot,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exit, stdout] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(exit).toBe(1);
      const envelope = JSON.parse(stdout);
      expect(envelope).toMatchObject({
        error: {
          _tag: "AppliedStateVersionError",
          path,
          storedVersion: newerVersion,
          supportedVersion: APPLIED_STATE_VERSION,
          writtenBy,
          scope,
        },
      });
      expect(await Bun.file(path).text()).toBe(bytes);
    });
  });
}
