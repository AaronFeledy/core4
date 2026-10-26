import { expect, test } from "bun:test";
import {
  AbsolutePath,
  type AppPlan,
  type BindMountPlan,
  PortablePath,
  ServiceName,
  serviceAppMount,
} from "@lando/sdk/schema";
import { applyMountCwd } from "../../src/scratch-app/service.ts";
import { plan, web } from "../operations/start-progress-topology-support.ts";

const appBind: BindMountPlan = {
  type: "bind",
  role: "app",
  origin: "service",
  relativeTo: "app",
  source: "/old",
  target: PortablePath.make("/app"),
  readOnly: false,
  realization: "accelerated",
  mountKey: "custom-app-key",
};

test.each(["/app", "/config"])(
  "explicit mount cwd at %s replaces only its primary bind and session",
  (target) => {
    // Given two services sharing a mount key and an independent primary session.
    const worker = ServiceName.make("worker");
    const replaced = { ...appBind, target: PortablePath.make(target) };
    const session = {
      app: { kind: "user" as const, id: plan.id, root: plan.root },
      service: web.name,
      mountKey: appBind.mountKey ?? "custom-app-key",
      source: AbsolutePath.make("/old"),
      target: { _tag: "volume" as const, name: "sync", path: replaced.target },
      mode: "two-way-safe" as const,
      excludes: [],
    };
    const input: AppPlan = {
      ...plan,
      root: AbsolutePath.make("/old"),
      services: {
        [web.name]: { ...web, mounts: [replaced] },
        [worker]: { ...web, name: worker, primary: false, mounts: [appBind] },
      },
      fileSync: [
        { engineId: "mutagen", session },
        { engineId: "mutagen", session: { ...session, service: worker } },
        { engineId: "mutagen", session: { ...session, mountKey: "other-key" } },
      ],
    };
    // When an explicit target replaces the primary app bind.
    const result = applyMountCwd(input, target, "/cwd");
    // Then only that bind and its session change, and app-role discovery still works.
    const primary = result?.services[web.name];
    expect(primary === undefined ? undefined : serviceAppMount(primary)).toEqual({
      type: "bind",
      origin: "authored",
      role: "app",
      source: "/cwd",
      target: PortablePath.make(target),
      readOnly: false,
      realization: "passthrough",
    });
    expect(result?.services[worker]).toEqual(input.services[worker]);
    expect(result?.fileSync).toEqual(input.fileSync.slice(1));
  },
);

test("mount cwd removes only the rebound app bind's file-sync session", async () => {
  // Given an app bind with a nonliteral session key and an independent session.
  const session = {
    app: { kind: "user" as const, id: plan.id, root: plan.root },
    service: web.name,
    mountKey: "custom-app-key",
    source: AbsolutePath.make("/old"),
    target: { _tag: "volume" as const, name: "sync", path: PortablePath.make("/app") },
    mode: "two-way-safe" as const,
    excludes: [],
  };
  const input: AppPlan = {
    ...plan,
    root: AbsolutePath.make("/old"),
    services: { [web.name]: { ...web, mounts: [appBind] } },
    fileSync: [
      { engineId: "mutagen", session },
      { engineId: "mutagen", session: { ...session, mountKey: "other-key" } },
    ],
  };
  // When the cwd replaces the app source.
  const result = applyMountCwd(input, undefined, "/cwd");
  // Then only the app session disappears and its bind becomes ordinary.
  expect(result?.fileSync.map(({ session }) => session.mountKey)).toEqual(["other-key"]);
  const service = result?.services[web.name];
  expect(service === undefined ? undefined : serviceAppMount(service)).toEqual({
    type: "bind",
    role: "app",
    origin: "service",
    relativeTo: "app",
    source: "/cwd",
    target: PortablePath.make("/app"),
    readOnly: false,
    realization: "passthrough",
  });
});

test("mount cwd replaces an occupied target when no app bind exists", async () => {
  // Given a volume at the requested target and a shallower tmpfs.
  const input: AppPlan = {
    ...plan,
    services: {
      [web.name]: {
        ...web,
        mounts: [
          { type: "volume", store: "old", target: PortablePath.make("/work/app"), readOnly: false },
          { type: "tmpfs", target: PortablePath.make("/work"), readOnly: false },
        ],
      },
    },
  };
  // When cwd is mounted over the occupied target.
  const result = applyMountCwd(input, "/work/app", "/cwd");
  // Then the replacement is unique and sorted after its parent.
  expect(result?.services[web.name]?.mounts).toEqual([
    { type: "tmpfs", target: PortablePath.make("/work"), readOnly: false },
    {
      type: "bind",
      source: "/cwd",
      target: PortablePath.make("/work/app"),
      origin: "authored",
      readOnly: false,
      realization: "passthrough",
    },
  ]);
});

test("mount cwd at another target adds a bind there and leaves the app mount alone", () => {
  // Given an app bind with a sync session and another mount at the requested target.
  const input: AppPlan = {
    ...plan,
    services: {
      [web.name]: {
        ...web,
        mounts: [appBind, { type: "tmpfs", target: PortablePath.make("/occupied"), readOnly: false }],
      },
    },
    fileSync: [
      {
        engineId: "mutagen",
        session: {
          app: { kind: "user" as const, id: plan.id, root: plan.root },
          service: web.name,
          mountKey: "custom-app-key",
          source: AbsolutePath.make("/old"),
          target: { _tag: "volume" as const, name: "sync", path: PortablePath.make("/app") },
          mode: "two-way-safe" as const,
          excludes: [],
        },
      },
    ],
  };
  // When cwd requests that destination.
  const result = applyMountCwd(input, "/occupied", "/cwd");
  // Then the app bind and its session stay, and the cwd bind replaces the occupant.
  expect(result?.services[web.name]?.mounts).toEqual([
    appBind,
    {
      type: "bind",
      source: "/cwd",
      target: PortablePath.make("/occupied"),
      origin: "authored",
      readOnly: false,
      realization: "passthrough",
    },
  ]);
  expect(result?.fileSync.map(({ session }) => session.mountKey)).toEqual(["custom-app-key"]);
});

test("mount cwd moves app-relative binds and keeps absolute binds", async () => {
  // Given a nested include bind under the app source and an unrelated host bind.
  const nested: BindMountPlan = {
    type: "bind",
    source: "/old/vendor/acme/sdk",
    relativeTo: "app",
    target: PortablePath.make("/app/vendor/acme/sdk"),
    readOnly: false,
    realization: "passthrough",
  };
  const unrelated: BindMountPlan = {
    type: "bind",
    source: "/srv/shared",
    target: PortablePath.make("/app/shared"),
    readOnly: true,
    realization: "passthrough",
  };
  const { mountKey: _key, ...passthroughApp } = { ...appBind, realization: "passthrough" as const };
  const input: AppPlan = {
    ...plan,
    services: { [web.name]: { ...web, mounts: [passthroughApp, unrelated, nested] } },
    root: AbsolutePath.make("/old"),
    fileSync: [],
  };
  // When the cwd replaces the app source at the same target.
  const result = applyMountCwd(input, undefined, "/cwd");
  // Then the mirrored bind follows the cwd and the unrelated bind is untouched.
  const binds = result?.services[web.name]?.mounts.flatMap((mount) =>
    mount.type === "bind" ? [{ source: mount.source, target: mount.target }] : [],
  );
  expect(binds).toEqual([
    { source: "/cwd", target: PortablePath.make("/app") },
    { source: "/srv/shared", target: PortablePath.make("/app/shared") },
    { source: "/cwd/vendor/acme/sdk", target: PortablePath.make("/app/vendor/acme/sdk") },
  ]);
});
