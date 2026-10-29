import { join, posix } from "node:path";
import { LandofileValidationError, ServiceFeatureError } from "@lando/sdk/errors";
import {
  type BindMountPlan,
  type MountPlan,
  type ProviderCapabilities,
  type ServiceConfig,
  type ServicePlan,
  duplicateMountTarget,
  orderMounts,
  serviceAppMount,
} from "@lando/sdk/schema";
import type { FileSystem } from "@lando/sdk/services";
import { type Context, Effect } from "effect";
import type { MountAuthoringContext } from "./authored-mount-entry.ts";
import { compileAuthoredMounts, excludeDestination, literalIncludeError } from "./authored-mounts.ts";
import { SERVICE_FEATURES_EXTENSION_KEY, serviceFeatureExtension } from "./extensions.ts";
import { mergeDefaultExcludes } from "./file-sync.ts";
import { kebab, shortHash } from "./naming.ts";
import { type ShadowHostCheck, checkShadowHosts } from "./shadow-host-checks.ts";
import { plannedContainerDestination } from "./storage.ts";

/** Authored declarations replace every feature tier before duplicate validation. */
export const prepareServiceMounts = (input: {
  readonly context: MountAuthoringContext;
  readonly servicePlan: ServicePlan;
  readonly normalizedConfig: ServiceConfig;
  readonly storage: ServiceConfig["storage"];
}): ServicePlan | LandofileValidationError | ServiceFeatureError => {
  const service = mergeDefaultExcludes(input.servicePlan);
  const authored = compileAuthoredMounts(input.context, input.normalizedConfig, input.storage);
  if (authored instanceof LandofileValidationError) return authored;
  const targets = new Set(authored.map((mount) => mount.target));
  const mounts: MountPlan[] = [];
  for (const mount of service.mounts) {
    const target = plannedContainerDestination(mount.target, input.context.appRoot, [
      "services",
      input.context.serviceName,
      "mounts",
    ]);
    if (target instanceof LandofileValidationError) return target;
    if (!targets.has(target)) mounts.push({ ...mount, target });
  }
  mounts.push(...authored);
  const duplicate = duplicateMountTarget(mounts);
  if (duplicate !== undefined)
    return new ServiceFeatureError({
      feature: "mounts",
      message: `Service ${input.context.serviceName} has multiple feature mounts at ${duplicate}.`,
      remediation: `Remove the conflicting feature mount, or author one mount at ${duplicate} to replace them.`,
    });
  const volumes = new Set<string>(
    mounts.filter((mount) => mount.type === "volume").map((mount) => mount.target),
  );
  const extension = serviceFeatureExtension(service.extensions);
  const trees = extension?.dataTrees;
  const dataTrees = Array.isArray(trees)
    ? trees.filter((tree: { readonly target: string }) => volumes.has(tree.target))
    : [];
  return {
    ...service,
    mounts,
    extensions: { ...service.extensions, [SERVICE_FEATURES_EXTENSION_KEY]: { ...extension, dataTrees } },
  };
};

/** A nested include may reopen its own shadow, never an intervening authored mount. */
export const deriveMountOverlays = Effect.fn("AppPlanner.deriveMountOverlays")(function* (input: {
  readonly context: MountAuthoringContext;
  readonly servicePlan: ServicePlan;
  readonly fileSystem?: Context.Service.Shape<typeof FileSystem> | undefined;
}): Effect.fn.Return<
  { readonly servicePlan: ServicePlan; readonly shadowHostChecks: readonly ShadowHostCheck[] },
  LandofileValidationError
> {
  const mounts = [...input.servicePlan.mounts];
  const checks: ShadowHostCheck[] = [];
  const shadows = new Map<BindMountPlan, Set<MountPlan>>();
  const binds = mounts.filter((mount): mount is BindMountPlan => mount.type === "bind");
  for (const bind of binds) {
    const owned = new Set<MountPlan>();
    shadows.set(bind, owned);
    for (const { exclude, ...check } of yield* checkShadowHosts(bind, input.fileSystem)) {
      const target = excludeDestination(input.context, bind.target, exclude, [
        "services",
        input.context.serviceName,
        bind.role === "app" ? "appMount" : "mounts",
        "excludes",
      ]);
      if (target instanceof LandofileValidationError) return yield* Effect.fail(target);
      if (mounts.some((mount) => mount.target === target)) continue;
      checks.push(check);
      if (!check.shadowed) continue;
      const shadow: MountPlan = {
        type: "volume",
        origin: "derived",
        store: `${input.context.appSlug}-${input.context.serviceName}-${kebab(target)}-${shortHash(target)}`,
        target,
        readOnly: false,
      };
      mounts.push(shadow);
      owned.add(shadow);
    }
  }
  for (const bind of binds) {
    for (const rel of bind.includes ?? []) {
      const path = [
        "services",
        input.context.serviceName,
        bind.role === "app" ? "appMount" : "mounts",
        "includes",
      ];
      const invalid = literalIncludeError(input.context, rel, path);
      if (invalid !== undefined) return yield* Effect.fail(invalid);
      const target = plannedContainerDestination(posix.join(bind.target, rel), input.context.appRoot, path);
      if (target instanceof LandofileValidationError) return yield* Effect.fail(target);
      if (mounts.some((mount) => mount.target === target)) continue;
      const parent = orderMounts(mounts.filter((mount) => target.startsWith(`${mount.target}/`))).at(-1);
      if (parent === undefined || !shadows.get(bind)?.has(parent)) continue;
      mounts.push({
        type: "bind",
        origin: "derived",
        ...(bind.relativeTo === undefined ? {} : { relativeTo: bind.relativeTo }),
        source: join(bind.source, rel),
        target,
        readOnly: bind.readOnly,
        realization: "passthrough",
      });
    }
  }
  return { servicePlan: { ...input.servicePlan, mounts }, shadowHostChecks: checks };
});

export const realizeServiceMounts = (
  service: ServicePlan,
  capabilities: ProviderCapabilities,
  accelerate = capabilities.bindMountPerformance === "slow",
): ServicePlan => ({
  ...service,
  mounts: orderMounts(service.mounts).map((mount) => {
    if (mount.type !== "bind") return mount;
    const { mountKey: _mountKey, ...bind } = mount;
    const realization = bind.role === "app" && accelerate ? "accelerated" : "passthrough";
    if (realization === "passthrough") return { ...bind, realization };
    return {
      ...bind,
      realization,
      mountKey: serviceAppMount(service) === mount ? "app-mount" : `mount-${shortHash(bind.target)}`,
    };
  }),
});
