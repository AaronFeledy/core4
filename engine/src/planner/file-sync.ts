import {
  AbsolutePath,
  type AppId,
  type FileSyncPlan,
  ServiceName,
  type ServicePlan,
  plannedFileSyncSessions,
} from "@lando/sdk/schema";

export const collectFileSyncEntries = (params: {
  readonly appId: ReturnType<typeof AppId.make>;
  readonly appRoot: string;
  readonly appName: string;
  readonly serviceName: string;
  readonly servicePlan: ServicePlan;
  readonly engineId: string;
}): ReadonlyArray<FileSyncPlan> => {
  const { appId, appRoot, appName, serviceName, servicePlan, engineId } = params;
  const app = { kind: "user" as const, id: appId, root: AbsolutePath.make(appRoot) };
  return (plannedFileSyncSessions({ name: appName, services: { [serviceName]: servicePlan } }) ?? []).map(
    (entry) => ({
      engineId,
      session: {
        app,
        service: ServiceName.make(entry.service),
        mountKey: entry.mountKey,
        source: AbsolutePath.make(entry.source),
        target: { _tag: "volume" as const, name: entry.volumeName, path: entry.targetPath },
        mode: "two-way-safe" as const,
        excludes: entry.excludes,
      },
    }),
  );
};
