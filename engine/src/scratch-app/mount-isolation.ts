import { lstat, realpath } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { ScratchAppError } from "@lando/sdk/errors";
import { MessageWarnEvent } from "@lando/sdk/events";
import { type AppPlan, PortablePath, ServiceName, orderMounts } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";
import { DateTime, Effect } from "effect";

const rootPathApi = (root: string) =>
  /^[a-z]:[\\/]/iu.test(root) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/u.test(root) ? win32 : posix;

const contains = (root: string, source: string): boolean => {
  const path = rootPathApi(root);
  const relative = path.relative(root, source);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export const findPrimaryServiceName = (plan: AppPlan): ServiceName | undefined => {
  const names = Object.keys(plan.services).map((name) => ServiceName.make(name));
  return names.find((name) => plan.services[name]?.primary === true) ?? names[0];
};

export const applyMountCwd = (
  plan: AppPlan,
  target: string | undefined,
  hostCwd: string,
): AppPlan | undefined => {
  const primaryName = findPrimaryServiceName(plan);
  const primary = primaryName === undefined ? undefined : plan.services[primaryName];
  if (primary === undefined) return undefined;
  if (target !== undefined) {
    const containerTarget = PortablePath.make(target);
    const replaced = primary.mounts.find((mount) => mount.target === containerTarget);
    const mountKey = replaced?.type === "bind" ? replaced.mountKey : undefined;
    return {
      ...plan,
      fileSync: plan.fileSync.filter(
        ({ session }) => !(session.service === primary.name && session.mountKey === mountKey),
      ),
      services: {
        ...plan.services,
        [primary.name]: {
          ...primary,
          mounts: orderMounts([
            ...primary.mounts.filter((mount) => mount.target !== containerTarget),
            {
              type: "bind",
              origin: "authored",
              source: hostCwd,
              target: containerTarget,
              readOnly: false,
              realization: "passthrough",
              ...(replaced?.type === "bind" && replaced.role === "app" ? { role: "app" as const } : {}),
            },
          ]),
        },
      },
    };
  }
  const path = rootPathApi(plan.root);
  const removedSessions = new Set<string>();
  const services = Object.fromEntries(
    Object.values(plan.services).map((service) => {
      const mounts = service.mounts.map((mount) => {
        if (mount.type !== "bind" || mount.relativeTo !== "app") return mount;
        const { mountKey, ...bind } = mount;
        if (mountKey !== undefined) removedSessions.add(`${service.name}/${mountKey}`);
        return {
          ...bind,
          source: path.resolve(hostCwd, path.relative(plan.root, mount.source)),
          realization: "passthrough" as const,
        };
      });
      return [service.name, { ...service, mounts }];
    }),
  );
  return {
    ...plan,
    services,
    fileSync: plan.fileSync.filter(
      ({ session }) => !removedSessions.has(`${session.service}/${session.mountKey}`),
    ),
  };
};

const sourceContained = async (root: string, source: string): Promise<boolean> => {
  if (!contains(root, source)) return false;
  const path = rootPathApi(root);
  const canonicalRoot = await realpath(root);
  let ancestor = source;
  while (true) {
    try {
      await lstat(ancestor);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return false;
      ancestor = parent;
      continue;
    }
    try {
      return contains(canonicalRoot, await realpath(ancestor));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  }
};

export const isolateScratchMounts = Effect.fn("ScratchAppService.isolateMounts")(function* (
  plan: AppPlan,
  suppressRelative: boolean,
) {
  const events = yield* EventService;
  const removedSessions = new Set<string>();
  const services = { ...plan.services };
  for (const service of Object.values(plan.services)) {
    const removedTargets: string[] = [];
    for (const mount of service.mounts) {
      if (mount.type !== "bind" || (suppressRelative && mount.origin === "derived")) continue;
      const relative = mount.relativeTo === "app";
      if (!(relative || (suppressRelative && mount.role === "app"))) continue;
      const keep =
        !suppressRelative &&
        (yield* Effect.tryPromise({
          try: () => sourceContained(plan.root, mount.source),
          catch: (cause) =>
            new ScratchAppError({
              operation: "acquire",
              message: `Unable to check scratch mount ${service.name}:${mount.target}.`,
              cause,
              remediation: "Check access to the scratch root and mount source, then retry.",
            }),
        }));
      if (keep) continue;
      removedTargets.push(mount.target);
      if (!suppressRelative)
        yield* events.publish(
          MessageWarnEvent.make({
            body: `Scratch isolation dropped mount ${service.name}:${mount.target} because its source escapes the scratch root.`,
            timestamp: yield* DateTime.now,
          }),
        );
    }
    const mounts = service.mounts.filter((mount) => {
      const owner =
        suppressRelative && mount.origin === "derived"
          ? service.mounts.reduce<string | undefined>(
              (deepest, candidate) =>
                candidate.type === "bind" &&
                candidate.origin !== "derived" &&
                candidate.target !== mount.target &&
                mount.target.startsWith(`${candidate.target.replace(/\/$/u, "")}/`) &&
                (deepest === undefined || candidate.target.length > deepest.length)
                  ? candidate.target
                  : deepest,
              undefined,
            )
          : undefined;
      const removed =
        removedTargets.includes(mount.target) || (owner !== undefined && removedTargets.includes(owner));
      if (removed && mount.type === "bind" && mount.mountKey !== undefined)
        removedSessions.add(`${service.name}/${mount.mountKey}`);
      return !removed;
    });
    services[service.name] = { ...service, mounts };
  }
  return {
    ...plan,
    services,
    fileSync: plan.fileSync.filter(
      ({ session }) => !removedSessions.has(`${session.service}/${session.mountKey}`),
    ),
  };
});
