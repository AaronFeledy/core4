import {
  AbsolutePath,
  type AppPlan,
  type BindMountPlan,
  ServiceName,
  plannedFileSyncSessions,
} from "@lando/sdk/schema";

export const withAcceleratedBind = (plan: AppPlan, service: ServiceName, mount: BindMountPlan): AppPlan => {
  const owner = plan.services[service];
  if (owner === undefined) throw new TypeError(`Missing fixture service ${service}`);
  const mounted = {
    ...plan,
    services: { ...plan.services, [service]: { ...owner, mounts: [...owner.mounts, mount] } },
  };
  const sessions = plannedFileSyncSessions(mounted);
  if (sessions === undefined) throw new TypeError("Accelerated fixture binds need mount keys");
  return {
    ...mounted,
    fileSync: sessions.map((session) => ({
      engineId: "mutagen",
      session: {
        app: { kind: "user", id: plan.id, root: plan.root },
        service: ServiceName.make(session.service),
        mountKey: session.mountKey,
        source: AbsolutePath.make(session.source),
        target: { _tag: "volume", name: session.volumeName, path: session.targetPath },
        mode: "two-way-safe",
        excludes: session.excludes,
      },
    })),
  };
};
