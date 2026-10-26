import { expect, test } from "bun:test";
import {
  AbsolutePath,
  type AppPlan,
  type BindMountPlan,
  PortablePath,
  serviceAppMount,
} from "@lando/sdk/schema";
import { Effect } from "effect";
import { applyMountCwd } from "../../src/scratch-app/service.ts";
import { plan, web } from "../operations/start-progress-topology-support.ts";

const appBind: BindMountPlan = {
  type: "bind",
  role: "app",
  source: "/old",
  target: PortablePath.make("/app"),
  readOnly: false,
  realization: "accelerated",
  mountKey: "custom-app-key",
};

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
    services: { [web.name]: { ...web, mounts: [appBind] } },
    fileSync: [
      { engineId: "mutagen", session },
      { engineId: "mutagen", session: { ...session, mountKey: "other-key" } },
    ],
  };
  // When the cwd replaces the app source.
  const result = await Effect.runPromise(applyMountCwd(input, undefined, "/cwd"));
  // Then only the app session disappears and its bind becomes ordinary.
  expect(result?.fileSync.map(({ session }) => session.mountKey)).toEqual(["other-key"]);
  const service = result?.services[web.name];
  expect(service === undefined ? undefined : serviceAppMount(service)).toEqual({
    type: "bind",
    role: "app",
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
  const result = await Effect.runPromise(applyMountCwd(input, "/work/app", "/cwd"));
  // Then the replacement is unique and sorted after its parent.
  expect(result?.services[web.name]?.mounts).toEqual([
    { type: "tmpfs", target: PortablePath.make("/work"), readOnly: false },
    {
      type: "bind",
      source: "/cwd",
      target: PortablePath.make("/work/app"),
      readOnly: false,
      realization: "passthrough",
    },
  ]);
});

test("mount cwd fails when moving the app bind collides with a planned target", async () => {
  // Given an app bind and another mount at the destination.
  const input: AppPlan = {
    ...plan,
    services: {
      [web.name]: {
        ...web,
        mounts: [appBind, { type: "tmpfs", target: PortablePath.make("/occupied"), readOnly: false }],
      },
    },
  };
  // When cwd requests that destination.
  const result = await Effect.runPromise(applyMountCwd(input, "/occupied", "/cwd").pipe(Effect.result));
  // Then the subsystem reports its tagged failure instead of duplicating mounts.
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") expect(result.failure._tag).toBe("ScratchAppError");
});
