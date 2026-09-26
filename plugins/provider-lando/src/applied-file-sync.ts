import { Effect } from "effect";

import type { PodmanApiClient } from "@lando/container-runtime/engine-api";
import type { PluginStateStore } from "@lando/sdk/plugins";
import {
  type AppPlan,
  type FileSyncSessionSpec,
  fileSyncVolumeName,
  sameAppMountTarget,
} from "@lando/sdk/schema";
import type { AppliedFileSyncInspection } from "@lando/sdk/services";

import { inspectAppliedPlan } from "./applied-state.ts";

export const verifiedFileSyncSessions = (plan: AppPlan): ReadonlyArray<FileSyncSessionSpec> | undefined => {
  const expected: Array<{
    service: string;
    mountKey: string;
    source: string;
    target: string;
    volume: string;
    excludes: ReadonlyArray<string>;
  }> = [];
  for (const [serviceName, service] of Object.entries(plan.services)) {
    const appMount = service.appMount;
    if (appMount?.realization === "accelerated") {
      expected.push({
        service: serviceName,
        mountKey: "app-mount",
        source: appMount.source,
        target: appMount.target,
        volume: fileSyncVolumeName(plan.name, serviceName, "app-mount"),
        excludes: appMount.excludes,
      });
    }
    for (const [index, mount] of service.mounts.entries()) {
      if (mount.type !== "bind" || mount.realization !== "accelerated") continue;
      if (sameAppMountTarget(appMount, mount)) continue;
      if (mount.source === undefined) return undefined;
      const mountKey = `mount-${index}`;
      expected.push({
        service: serviceName,
        mountKey,
        source: mount.source,
        target: mount.target,
        volume: fileSyncVolumeName(plan.name, serviceName, mountKey),
        excludes: [],
      });
    }
  }
  if (expected.length === 0 || plan.fileSync.length !== expected.length) return undefined;
  const seen = new Set<string>();
  for (const { session } of plan.fileSync) {
    const key = `${session.service}/${session.mountKey}`;
    const mount = expected.find((candidate) => `${candidate.service}/${candidate.mountKey}` === key);
    if (
      mount === undefined ||
      seen.has(key) ||
      session.app.kind !== "user" ||
      session.app.id !== plan.id ||
      session.app.root !== plan.root ||
      session.source !== mount.source ||
      session.mode !== "two-way-safe" ||
      session.permissions !== undefined ||
      session.excludes.length !== mount.excludes.length ||
      session.excludes.some((exclude, index) => exclude !== mount.excludes[index]) ||
      session.target._tag !== "volume" ||
      session.target.name !== mount.volume ||
      session.target.path !== mount.target
    )
      return undefined;
    seen.add(key);
  }
  return plan.fileSync.map(({ session }) => session);
};

const expectedVolumeNames = (plan: AppPlan): ReadonlySet<string> =>
  new Set(
    plan.fileSync.map(({ session }) => fileSyncVolumeName(plan.name, session.service, session.mountKey)),
  );

const syncVolumeEvidence = (body: string, plan: AppPlan): "none" | "accelerated" | "unknown" => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "unknown";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "unknown";
  const volumes = Reflect.get(parsed, "Volumes");
  if (volumes === null) return "none";
  if (!Array.isArray(volumes)) return "unknown";
  const expected = expectedVolumeNames(plan);
  const appPrefix = `${plan.name}-`.replace(/[^a-zA-Z0-9_.-]/gu, "-");
  const plausiblePreviousSyncName = (name: string): boolean =>
    name.startsWith(appPrefix) && (name.endsWith("-app-mount") || /-mount-[0-9]+$/u.test(name));
  for (const item of volumes) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return "unknown";
    const name = Reflect.get(item, "Name");
    const labels = Reflect.get(item, "Labels");
    if (typeof name !== "string") return "unknown";
    if (labels !== null && labels !== undefined && (typeof labels !== "object" || Array.isArray(labels)))
      return "unknown";
    const app = labels === null || labels === undefined ? undefined : Reflect.get(labels, "dev.lando.app");
    const kind =
      labels === null || labels === undefined ? undefined : Reflect.get(labels, "dev.lando.sync.kind");
    if (app === String(plan.id) && kind === "volume") return "accelerated";
    if (expected.has(name) || plausiblePreviousSyncName(name)) return "unknown";
  }
  return "none";
};

/** Inspect durable provider state and managed Podman volumes before changing mount realization. */
export const inspectAppliedFileSync = (
  stateStore: PluginStateStore,
  api: Pick<PodmanApiClient, "request">,
  plan: AppPlan,
): Effect.Effect<AppliedFileSyncInspection> =>
  Effect.gen(function* () {
    const prior = yield* inspectAppliedPlan(stateStore, plan.id);
    if (prior.status === "unreadable") return { status: "unknown" } as const;
    if (prior.status === "readable") {
      if (prior.plan.id !== plan.id || prior.plan.root !== plan.root) return { status: "unknown" } as const;
      const sessions = verifiedFileSyncSessions(prior.plan);
      if (sessions !== undefined) {
        const engineIds = [...new Set(prior.plan.fileSync.map((entry) => entry.engineId))];
        if (engineIds.length !== 1 || engineIds[0] === undefined) return { status: "unknown" } as const;
        return { status: "accelerated", engineId: engineIds[0], sessions } as const;
      }
      if (
        prior.plan.fileSync.length > 0 ||
        Object.values(prior.plan.services).some(
          (service) =>
            service.appMount?.realization === "accelerated" ||
            service.mounts.some((mount) => mount.type === "bind" && mount.realization === "accelerated"),
        )
      )
        return { status: "unknown" } as const;
    }
    if (api.request === undefined) return { status: "unknown" } as const;
    const response = yield* api
      .request({ method: "GET", path: "/volumes" })
      .pipe(Effect.catchAll(() => Effect.succeed(undefined)));
    if (response === undefined || response.status !== 200) return { status: "unknown" } as const;
    const evidence = syncVolumeEvidence(response.body, plan);
    if (evidence !== "none") return { status: "unknown" } as const;
    return { status: prior.status === "readable" ? "ordinary" : "missing" } as const;
  });
