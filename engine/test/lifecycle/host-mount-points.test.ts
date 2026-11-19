import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BindMountPlan, MountPlan } from "@lando/sdk/schema";
import { PortablePath } from "@lando/sdk/schema";
import { Effect } from "effect";
import {
  HostMountPoints,
  type HostMountService,
  appRelativeSegments,
  hostMountDirectories,
} from "../../src/lifecycle/host-mount-points.ts";

const appBind = (overrides: Partial<BindMountPlan> = {}): BindMountPlan => ({
  type: "bind",
  source: "/host/app",
  target: PortablePath.make("/app"),
  readOnly: false,
  realization: "passthrough",
  role: "app",
  ...overrides,
});

const volume = (target: string): MountPlan => ({
  type: "volume",
  store: "shadow",
  target: PortablePath.make(target),
  readOnly: false,
});

const tmpfs = (target: string): MountPlan => ({
  type: "tmpfs",
  target: PortablePath.make(target),
  readOnly: false,
});

const bind = (
  source: string,
  target: string,
  realization: "passthrough" | "accelerated" = "passthrough",
): MountPlan => ({
  type: "bind",
  source,
  target: PortablePath.make(target),
  readOnly: false,
  realization,
  ...(realization === "accelerated" ? { mountKey: "mount-key" } : {}),
});

const service = (overrides: Partial<HostMountService> = {}): HostMountService => ({
  name: "app",
  mounts: [appBind()],
  ...overrides,
});

const withRoot = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "lando-host-mount-points-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

test("maps the working directory and every nested mount point through the app bind", () => {
  const directories = hostMountDirectories([
    service({
      workingDirectory: "/app/web",
      mounts: [
        appBind(),
        volume("/app/vendor"),
        tmpfs("/app/tmp"),
        bind("/host/cache", "/app/cache"),
        bind("/host/accelerated", "/app/accelerated", "accelerated"),
      ],
    }),
  ]);

  expect(directories.map((directory) => directory.path)).toEqual([
    "/host/app/web",
    "/host/app/vendor",
    "/host/app/tmp",
    "/host/app/cache",
    "/host/app/accelerated",
  ]);
  expect(directories.map((directory) => directory.target)).toEqual([
    "/app/web",
    "/app/vendor",
    "/app/tmp",
    "/app/cache",
    "/app/accelerated",
  ]);
  expect(directories.every((directory) => directory.service === "app")).toBe(true);
});

test("ignores a working directory and mounts outside the app bind", () => {
  const directories = hostMountDirectories([
    service({
      workingDirectory: "/var/www",
      mounts: [appBind(), volume("/data"), bind("/host/conf", "/etc/lando/conf")],
    }),
  ]);

  expect(directories).toEqual([]);
  expect(appRelativeSegments("/app", "/app-other/web")).toBeUndefined();
  expect(appRelativeSegments("/app", "/app")).toBeUndefined();
});

test("refuses parent traversal in a container target", () => {
  expect(appRelativeSegments("/app", "/app/../escape")).toBeUndefined();
  expect(appRelativeSegments("/app", "/app/web/../../etc")).toBeUndefined();

  const directories = hostMountDirectories([
    service({
      workingDirectory: "/app/../escape",
      mounts: [appBind(), volume("/app/web/../../etc")],
    }),
  ]);

  expect(directories).toEqual([]);
});

test("skips an accelerated app mount that has no host source", () => {
  const directories = hostMountDirectories([
    service({
      workingDirectory: "/app/web",
      mounts: [appBind({ realization: "accelerated" }), volume("/app/vendor")],
    }),
    { name: "no-mount", workingDirectory: "/app/web", mounts: [] },
  ]);

  expect(directories).toEqual([]);
});

test("creates the working directory and mount points as the host user", async () => {
  await withRoot(async (root) => {
    const plan = {
      services: {
        app: {
          ...service({
            workingDirectory: "/app/web",
            mounts: [appBind({ source: root }), volume("/app/vendor"), tmpfs("/app/tmp")],
          }),
        },
      },
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const hostMountPoints = yield* HostMountPoints;
        yield* hostMountPoints.prepare(plan);
      }).pipe(Effect.provide(HostMountPoints.layer)),
    );

    for (const directory of ["web", "vendor", "tmp"]) {
      const info = await stat(join(root, directory));
      expect(info.isDirectory()).toBe(true);
      expect(`${info.uid}:${info.gid}`).toBe(`${process.getuid?.()}:${process.getgid?.()}`);
    }
  });
});

test("leaves an existing directory untouched", async () => {
  await withRoot(async (root) => {
    await mkdir(join(root, "web"), { mode: 0o700 });
    const before = await stat(join(root, "web"));
    const plan = {
      services: { app: service({ workingDirectory: "/app/web", mounts: [appBind({ source: root })] }) },
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const hostMountPoints = yield* HostMountPoints;
        yield* hostMountPoints.prepare(plan);
      }).pipe(Effect.provide(HostMountPoints.layer)),
    );

    const after = await stat(join(root, "web"));
    expect(after.mode & 0o777).toBe(before.mode & 0o777);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});

test("refuses to create through a symlink that leaves the app root", async () => {
  await withRoot(async (root) => {
    const outside = await mkdtemp(join(tmpdir(), "lando-host-mount-outside-"));
    try {
      await symlink(outside, join(root, "web"));
      const plan = {
        services: {
          app: service({ workingDirectory: "/app/web/nested", mounts: [appBind({ source: root })] }),
        },
      };

      await Effect.runPromise(
        Effect.gen(function* () {
          const hostMountPoints = yield* HostMountPoints;
          yield* hostMountPoints.prepare(plan);
        }).pipe(Effect.provide(HostMountPoints.layer)),
      );

      expect(await exists(join(outside, "nested"))).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("treats an invisible bind source as a no-op and creates a file mount point as an empty host file", async () => {
  await withRoot(async (root) => {
    const source = join(root, "config.inc");
    await writeFile(source, "config");
    const plan = {
      services: {
        app: service({
          workingDirectory: "/app/web",
          mounts: [appBind({ source: join(root, "missing") })],
        }),
        file: service({
          name: "file",
          mounts: [appBind({ source: root }), bind(source, "/app/settings/config.inc")],
        }),
      },
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const hostMountPoints = yield* HostMountPoints;
        yield* hostMountPoints.prepare(plan);
      }).pipe(Effect.provide(HostMountPoints.layer)),
    );

    expect(await exists(join(root, "missing", "web"))).toBe(false);
    // The runtime would otherwise create both as an id the host user cannot write.
    const parent = await stat(join(root, "settings"));
    expect(parent.isDirectory()).toBe(true);
    expect(`${parent.uid}:${parent.gid}`).toBe(`${process.getuid?.()}:${process.getgid?.()}`);
    const placeholder = await stat(join(root, "settings", "config.inc"));
    expect(placeholder.isFile()).toBe(true);
    expect(placeholder.size).toBe(0);
    expect(`${placeholder.uid}:${placeholder.gid}`).toBe(`${process.getuid?.()}:${process.getgid?.()}`);
  });
});

test("leaves an existing file mount point untouched", async () => {
  await withRoot(async (root) => {
    const source = join(root, "config.inc");
    await writeFile(source, "config");
    await mkdir(join(root, "settings"));
    await writeFile(join(root, "settings", "config.inc"), "kept");
    const plan = {
      services: {
        file: service({
          name: "file",
          mounts: [appBind({ source: root }), bind(source, "/app/settings/config.inc")],
        }),
      },
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const hostMountPoints = yield* HostMountPoints;
        yield* hostMountPoints.prepare(plan);
      }).pipe(Effect.provide(HostMountPoints.layer)),
    );

    expect(await Bun.file(join(root, "settings", "config.inc")).text()).toBe("kept");
  });
});

test("uses an injected preparation service", async () => {
  const prepared: string[] = [];
  const plan = { services: { app: service({ workingDirectory: "/app/web" }) } };

  await Effect.runPromise(
    Effect.gen(function* () {
      const hostMountPoints = yield* HostMountPoints;
      yield* hostMountPoints.prepare(plan);
    }).pipe(
      Effect.provideService(
        HostMountPoints,
        HostMountPoints.of({
          prepare: () =>
            Effect.sync(() => {
              prepared.push("prepare");
            }),
        }),
      ),
    ),
  );

  expect(prepared).toEqual(["prepare"]);
});
