import { join, posix } from "node:path";
import { sameRealpath } from "@lando/paths";
import {
  type AppPlan,
  type FileSyncInfo,
  FileSyncPolicyInfo,
  type FileSyncPolicyReason,
  serviceAppMount,
} from "@lando/sdk/schema";
import { Result, Schema } from "effect";
import { normalizeFileSyncBundle } from "./file-sync-bundle.ts";

const matchesReason = (
  mode: "accelerated" | "ordinary" | "absent",
  reason: FileSyncPolicyReason,
): boolean => {
  const selection = reason === "explicit-engine" || reason === "default-engine" || reason === "sole-engine";
  if (reason === "unknown") return true;
  switch (mode) {
    case "accelerated":
      return selection;
    case "ordinary":
      return !selection && reason !== "absent-app-mount";
    case "absent":
      return reason === "absent-app-mount";
    default:
      return mode satisfies never;
  }
};

export const projectFileSyncPolicy = (plan: AppPlan, services?: readonly string[]): FileSyncPolicyInfo => {
  const bundle = normalizeFileSyncBundle(plan);
  const valid = Result.isSuccess(bundle);
  const engineId = valid && bundle.success.kind === "accelerated" ? bundle.success.id : undefined;
  const recorded = plan.fileSyncPolicy;
  const policyMode =
    engineId !== undefined
      ? "accelerated"
      : Object.values(plan.services).some((service) => serviceAppMount(service) !== undefined)
        ? "ordinary"
        : "absent";
  const metadataMatches =
    valid &&
    recorded !== undefined &&
    recorded.engineId === engineId &&
    matchesReason(policyMode, recorded.reason) &&
    Object.keys(recorded.services).length === Object.keys(plan.services).length &&
    Object.entries(plan.services).every(([name, service]) => {
      const mount = serviceAppMount(service);
      const mode =
        mount === undefined ? "absent" : mount.realization === "accelerated" ? "accelerated" : "ordinary";
      const facts = recorded.services[name];
      return facts?.mode === mode && matchesReason(mode, facts.reason);
    });
  // Selection is a view: bundle coverage and explanatory metadata require the complete plan above.
  const selectedServices = Object.entries(plan.services).filter(
    ([name]) => services === undefined || services.includes(name),
  );
  return {
    mode: valid ? (engineId === undefined ? "ordinary" : "accelerated") : "unknown",
    ...(engineId === undefined ? {} : { engineId }),
    reason: metadataMatches ? recorded.reason : "unknown",
    services: selectedServices.map(([name, service]) => {
      const mount = serviceAppMount(service);
      const accelerated = mount?.realization === "accelerated";
      const sessions = plan.fileSync.filter(({ session }) => session.service === name);
      return {
        service: name,
        mode: !valid ? "unknown" : mount === undefined ? "absent" : accelerated ? "accelerated" : "ordinary",
        reason: metadataMatches ? (recorded.services[name]?.reason ?? "unknown") : "unknown",
        exclusions: {
          kind: !valid
            ? "unknown"
            : mount === undefined
              ? "none"
              : accelerated
                ? "transport-patterns"
                : "directory-overlays",
          patterns: valid && accelerated ? sessions.flatMap(({ session }) => session.excludes) : [],
          overlays:
            mount === undefined
              ? []
              : service.mounts
                  .filter(
                    (candidate) =>
                      candidate.type === "volume" &&
                      candidate.origin === "derived" &&
                      candidate.target !== mount.target &&
                      candidate.target.startsWith(posix.join(mount.target, "/")),
                  )
                  .map(({ target }) => String(target)),
        },
        hostBackedIncludes:
          mount === undefined
            ? []
            : (mount.includes ?? []).flatMap((include) => {
                const source = join(mount.source, include);
                const target = posix.join(mount.target, include);
                const effective = service.mounts
                  .filter(
                    (candidate) =>
                      target === candidate.target || target.startsWith(posix.join(candidate.target, "/")),
                  )
                  .sort((left, right) => right.target.length - left.target.length)[0];
                return effective?.type === "bind" &&
                  effective.realization !== "accelerated" &&
                  sameRealpath(join(effective.source, posix.relative(effective.target, target)), source)
                  ? [{ source, target }]
                  : [];
              }),
      };
    }),
  };
};

export const projectFileSyncInfo = (
  planned: AppPlan | undefined,
  applied: AppPlan | undefined,
  services?: readonly string[],
): FileSyncInfo => {
  const plannedPolicy = planned === undefined ? undefined : projectFileSyncPolicy(planned, services);
  const appliedPolicy = applied === undefined ? undefined : projectFileSyncPolicy(applied, services);
  return {
    ...(plannedPolicy === undefined ? {} : { planned: plannedPolicy }),
    ...(appliedPolicy === undefined ? {} : { applied: appliedPolicy }),
    pendingChange:
      plannedPolicy !== undefined &&
      appliedPolicy !== undefined &&
      plannedPolicy.mode !== "unknown" &&
      appliedPolicy.mode !== "unknown" &&
      !Schema.toEquivalence(FileSyncPolicyInfo)(plannedPolicy, appliedPolicy),
  };
};
