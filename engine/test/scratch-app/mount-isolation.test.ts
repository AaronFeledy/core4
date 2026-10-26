import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbsolutePath, type AppPlan, type BindMountPlan, PortablePath, ServiceName } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";
import { Effect } from "effect";
import { applyMountCwd, isolateScratchMounts } from "../../src/scratch-app/mount-isolation.ts";
import * as Events from "../../src/services/event-service.ts";
import { plan, service } from "../operations/info-storage-fixture.ts";

const bind = (source: string, target: string, extra: Partial<BindMountPlan> = {}): BindMountPlan => ({
  type: "bind",
  source,
  target: PortablePath.make(target),
  readOnly: false,
  realization: "accelerated",
  relativeTo: "app",
  origin: "authored",
  mountKey: target,
  ...extra,
});

const absoluteBind = (source: string, target: string): BindMountPlan => {
  const { relativeTo: _relativeTo, ...mount } = bind(source, target);
  return mount;
};

test.each([
  ["/project", "/project/config/dev", "/cwd", "/cwd/config/dev"],
  ["C:\\project", "C:\\shared", "D:\\cwd", "D:\\shared"],
  [
    "\\\\host\\share\\project",
    "\\\\host\\share\\project\\config",
    "\\\\other\\share\\cwd",
    "\\\\other\\share\\cwd\\config",
  ],
] as const)(
  "cwd rebases app-relative binds in every service using root platform %s",
  (root, source, cwd, expected) => {
    // Given a secondary service with a non-mirroring relative bind and an absolute sibling.
    const name = ServiceName.make("worker");
    const relativeBind = bind(source, "/etc/config");
    const absolute = absoluteBind(source, "/absolute");
    const session = {
      app: { kind: "user" as const, id: plan.id, root: AbsolutePath.make(root) },
      service: name,
      mountKey: "/etc/config",
      source: AbsolutePath.make(source),
      target: { _tag: "volume" as const, name: "sync", path: PortablePath.make("/") },
      mode: "two-way-safe" as const,
      excludes: [],
    };
    const input: AppPlan = {
      ...plan,
      root: AbsolutePath.make(root),
      services: {
        [service.name]: service,
        [name]: { ...service, name, primary: false, mounts: [relativeBind, absolute] },
      },
      fileSync: [{ engineId: "mutagen", session }],
    };
    // When bare cwd isolation is applied.
    const result = applyMountCwd(input, undefined, cwd);
    // Then the relative bind is plain passthrough, independent of its container target.
    expect(result?.services[name]?.mounts[0]).toMatchObject({ source: expected, realization: "passthrough" });
    expect(result?.services[name]?.mounts[0]).not.toHaveProperty("mountKey");
    expect(result?.services[name]?.mounts[1]).toEqual(absolute);
    expect(result?.fileSync).toEqual([]);
  },
);

test("owned-root isolation drops lexical and symlink escapes, including missing descendants", async () => {
  // Given a scratch root with safe and escaping links.
  const directory = await mkdtemp(join(tmpdir(), "lando-scratch-containment-"));
  try {
    const root = join(directory, "root");
    await mkdir(join(root, "safe"), { recursive: true });
    await mkdir(join(directory, "outside"));
    await symlink(join(directory, "outside"), join(root, "escape"), "dir");
    await symlink(join(root, "safe"), join(root, "inside"), "dir");
    const mounts = [
      bind(root, "/app", { role: "app", origin: "service" }),
      bind(join(root, "..", "outside"), "/lexical"),
      bind(join(root, "escape"), "/symlink"),
      bind(join(root, "escape", "missing", "child"), "/missing"),
      bind(join(root, "inside", "missing"), "/safe"),
      absoluteBind(join(directory, "outside"), "/absolute"),
    ];
    const input: AppPlan = {
      ...plan,
      root: AbsolutePath.make(root),
      services: { [service.name]: { ...service, mounts } },
      fileSync: mounts.map((mount) => ({
        engineId: "mutagen",
        session: {
          app: { kind: "user", id: plan.id, root: AbsolutePath.make(root) },
          service: service.name,
          mountKey: mount.target,
          source: AbsolutePath.make(mount.source),
          target: { _tag: "volume", name: "sync", path: mount.target },
          mode: "two-way-safe",
          excludes: [],
        },
      })),
    };
    // When acquisition checks the materialized root.
    const { result, warnings } = await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* isolateScratchMounts(input, false);
        const events = yield* EventService;
        return { result, warnings: yield* events.query("message.warn") };
      }).pipe(Effect.provide(Events.layer)),
    );
    // Then only contained and absolute sources survive, with one warning per rejection.
    expect(result.services[service.name]?.mounts.map((mount) => String(mount.target))).toEqual([
      "/app",
      "/safe",
      "/absolute",
    ]);
    expect(result.fileSync.map(({ session }) => session.mountKey)).toEqual(["/app", "/safe", "/absolute"]);
    expect(warnings).toHaveLength(3);
    for (const target of ["/lexical", "/symlink", "/missing"])
      expect(warnings.filter(({ body }) => body.includes(`${service.name}:${target}`))).toHaveLength(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fork baked removes relative binds and only derived descendants of their targets", async () => {
  // Given app and relative mounts from the original root with different ownership below them.
  const mounts = [
    bind("/original", "/app", { role: "app" }),
    bind("/original/config", "/config"),
    {
      type: "volume" as const,
      origin: "derived" as const,
      store: "vendor",
      target: PortablePath.make("/app/vendor"),
      readOnly: false,
    },
    {
      type: "volume" as const,
      origin: "authored" as const,
      store: "data",
      target: PortablePath.make("/app/data"),
      readOnly: false,
    },
    absoluteBind("/absolute", "/app/shared"),
    {
      type: "tmpfs" as const,
      origin: "derived" as const,
      target: PortablePath.make("/config/cache"),
      readOnly: false,
    },
  ];
  const input = { ...plan, services: { [service.name]: { ...service, mounts } } };
  // When baked isolation suppresses original app-relative sources.
  const result = await Effect.runPromise(
    isolateScratchMounts(input, true).pipe(Effect.provide(Events.layer)),
  );
  // Then authored descendants and absolute binds remain.
  expect(result.services[service.name]?.mounts.map((mount) => String(mount.target))).toEqual([
    "/app/data",
    "/app/shared",
  ]);
});
