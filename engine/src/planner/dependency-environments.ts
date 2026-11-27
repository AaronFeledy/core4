import { posix, relative, sep } from "node:path";
import { PROJECT_USER_MAPPING_EXTENSION_KEY } from "@lando/container-runtime/project-user-realization";
import { canonicalJson, sha256Hex } from "@lando/sdk/digest";
import { LandofileValidationError } from "@lando/sdk/errors";
import {
  CLONED_SERVICE_PROVENANCE_KEY,
  DEPENDENCY_ENVIRONMENT_EXTENSION_KEY,
  type DependencyEnvironmentIntent,
  DependencyEnvironmentJob,
  PortablePath,
  type ProviderCapabilities,
  ServiceName,
  type ServicePlan,
  type VolumeMountPlan,
  landoCacheStoreName,
  landoDependencyEnvironmentStoreName,
  landoServiceContainerName,
  orderMounts,
  serviceAppMount,
  validationIssue,
} from "@lando/sdk/schema";
import { Predicate, Schema } from "effect";
import { dnsNameClaims } from "./dns-name-validation.ts";
import { SERVICE_FEATURES_EXTENSION_KEY, serviceFeatureBuildSteps } from "./extensions.ts";
import type { PlannedServiceDraft } from "./service-types.ts";

type Store = {
  readonly name: string;
  readonly kind: "data" | "cache";
  readonly scope: "app" | "global";
  readonly key?: string;
};
type Group = {
  readonly key: string;
  readonly digest: string;
  readonly intent: DependencyEnvironmentIntent;
  readonly owner: string;
  readonly mount: VolumeMountPlan;
  readonly members: Set<string>;
};

const volume = (store: string, target: string): VolumeMountPlan => ({
  type: "volume",
  store,
  target: PortablePath.make(target),
  origin: "service",
  readOnly: false,
});
const compose = (service: ServicePlan) =>
  Predicate.isObject(service.extensions.compose) ? service.extensions.compose : {};

export const createDependencyEnvironments = (input: {
  readonly appRoot: string;
  readonly appSlug: string;
  readonly nativeSlug?: string;
  readonly dataSlug?: string;
  readonly appKind?: "user" | "scratch" | "global";
  readonly providerCapabilities: ProviderCapabilities;
  readonly plannedServiceDrafts: readonly PlannedServiceDraft[];
}) => {
  const groups = new Map<string, Group>();
  const consumers = new Map<string, ServicePlan>();
  const stores = new Map<string, Store>();
  const conflict = (path: readonly string[], message: string, remediation: string) =>
    new LandofileValidationError({
      file: input.appRoot,
      message,
      remediation,
      issues: [{ ...validationIssue(path, message), suggestion: remediation }],
    });

  const prepare = (
    service: ServicePlan,
    entry: PlannedServiceDraft,
  ): ServicePlan | LandofileValidationError => {
    const app = serviceAppMount(service);
    if (app === undefined || (input.appKind ?? "user") !== "user") return service;
    const source = relative(input.appRoot, app.source).split(sep).join("/");
    if (source === ".." || source.startsWith("../")) return service;
    const owner =
      service.projectUser === undefined
        ? (service.user ?? "root")
        : `${service.projectUser.uid}:${service.projectUser.gid}`;
    const mounts = [...service.mounts];
    const environment = { ...service.environment };
    for (const intent of entry.dependencyEnvironments ?? []) {
      const target = posix.normalize(intent.target);
      if (target !== intent.target || !target.startsWith(`${app.target === "/" ? "" : app.target}/`)) {
        return conflict(
          ["services", service.name],
          `Invalid dependency environment target ${intent.target}.`,
          "Declare a canonical target below the app mount.",
        );
      }
      if (mounts.some((mount) => mount.target === target && mount.origin === "authored")) continue;
      if (mounts.some((mount) => mount.target === target)) {
        return conflict(
          ["services", service.name],
          `Another feature already mounts ${target}.`,
          "Choose a distinct target for the dependency environment.",
        );
      }
      const artifact = {
        base: service.artifact,
        steps: entry.draft.buildSteps
          .filter((step) => step.phase === "build")
          .map((step) => ({ ...step, user: step.user ?? service.user ?? "root" })),
      };
      const key = canonicalJson({
        kind: intent.kind,
        identity: intent.identity,
        target,
        source,
        owner,
        platform: compose(service).platform ?? null,
        artifact: sha256Hex(canonicalJson(artifact)),
        mapping:
          service.projectUser === undefined
            ? null
            : (service.extensions[PROJECT_USER_MAPPING_EXTENSION_KEY] ?? "keep-id"),
      });
      const digest = sha256Hex(key);
      const name = landoDependencyEnvironmentStoreName(input.dataSlug ?? input.appSlug, intent.kind, digest);
      const existing = groups.get(name);
      if (existing !== undefined && existing.key !== key) {
        return conflict(
          ["services", service.name],
          `Dependency environments collide at store ${name}.`,
          "Change the dependency environment kind or identity.",
        );
      }
      const mount = existing?.mount ?? volume(name, target);
      const group = existing ?? { key, digest, intent, owner, mount, members: new Set<string>() };
      group.members.add(service.name);
      groups.set(name, group);
      stores.set(name, { name, scope: "app", kind: "data", key: digest });
      mounts.push(mount);
      for (const [variable, value] of Object.entries(intent.activation ?? {})) {
        environment[variable] ??= value;
      }
    }
    return { ...service, environment, mounts: orderMounts(mounts) };
  };

  const finish = () => {
    const updated = new Map<string, ServicePlan>();
    const claimed = new Map(
      dnsNameClaims({
        services: Object.fromEntries(
          input.plannedServiceDrafts.map((entry) => [entry.name, entry.draft.normalizedConfig]),
        ),
        appSlug: input.appSlug,
      }).map((claim) => [claim.name.toLowerCase(), claim.service]),
    );
    for (const name of consumers.keys())
      claimed.set(landoServiceContainerName(input.nativeSlug ?? input.appSlug, name).toLowerCase(), name);
    const counts = new Map<string, number>();
    for (const { intent } of groups.values()) counts.set(intent.kind, (counts.get(intent.kind) ?? 0) + 1);
    for (const group of groups.values()) {
      const { intent, digest, owner, mount } = group;
      const names = [...group.members].sort();
      const [first, ...rest] = names;
      if (first === undefined) continue;
      const representative = consumers.get(first);
      if (representative === undefined) continue;
      const app = serviceAppMount(representative);
      if (app === undefined) continue;
      const name = ServiceName.make(
        `${intent.kind}-env${counts.get(intent.kind) === 1 ? "" : `-${digest.slice(0, 8)}`}`,
      );
      const claims = [
        name,
        `${name}.${input.appSlug}.internal`,
        landoServiceContainerName(input.nativeSlug ?? input.appSlug, name),
      ];
      for (const value of claims) {
        const previous = claimed.get(value.toLowerCase());
        if (previous !== undefined)
          return conflict(
            ["services", previous],
            `Dependency environment job ${name} conflicts with service ${previous} at ${value}.`,
            "Rename the conflicting service, hostname or network alias.",
          );
      }
      for (const value of claims) claimed.set(value.toLowerCase(), first);
      const { excludes: _excludes, includes: _includes, mountKey: _mountKey, ...bind } = app;
      const jobMounts = [{ ...bind, realization: "passthrough" as const }, mount];
      const environment = { ...representative.environment };
      if (intent.cache !== undefined) {
        const cache = landoCacheStoreName(intent.cache.name);
        stores.set(cache, { name: cache, scope: "global", kind: "cache" });
        jobMounts.push(volume(cache, intent.cache.target));
        environment[intent.cache.variable] = intent.cache.target;
      }
      const platform = compose(representative).platform;
      const job: ServicePlan = {
        name,
        type: representative.type,
        provider: representative.provider,
        primary: false,
        environment,
        ...(representative.artifact === undefined ? {} : { artifact: representative.artifact }),
        ...(representative.pullPolicy === undefined ? {} : { pullPolicy: representative.pullPolicy }),
        entrypoint: [],
        command: [...intent.prepare, owner],
        user: "root",
        init: true,
        ...(representative.projectUser === undefined ||
        representative.extensions[PROJECT_USER_MAPPING_EXTENSION_KEY] === "image-renumber"
          ? {}
          : { projectUser: representative.projectUser }),
        workingDirectory: app.target,
        mounts: orderMounts(jobMounts),
        endpoints: [],
        routes: [],
        dependsOn: [],
        hostAliases: [],
        metadata: representative.metadata,
        healthcheck: { kind: "none", intervalSeconds: 10, timeoutSeconds: 5, retries: 5 },
        provenance: {
          [CLONED_SERVICE_PROVENANCE_KEY]: { feature: DEPENDENCY_ENVIRONMENT_EXTENSION_KEY, from: first },
        },
        extensions: {
          compose: {
            ...(input.providerCapabilities.composeKnobs?.supported?.includes("restart")
              ? { restart: "no" }
              : {}),
            ...(platform === undefined ? {} : { platform }),
          },
          [SERVICE_FEATURES_EXTENSION_KEY]: {
            buildSteps: serviceFeatureBuildSteps(representative.extensions)
              .filter((step) => step.phase === "build")
              .map((step) => ({ ...step, user: step.user ?? representative.user ?? "root" })),
          },
          [DEPENDENCY_ENVIRONMENT_EXTENSION_KEY]: {
            kind: intent.kind,
            consumers: [first, ...rest],
            ...(intent.inputs === undefined ? {} : { inputs: intent.inputs }),
          } satisfies typeof DependencyEnvironmentJob.Type,
        },
      };
      updated.set(name, job);
      for (const consumer of names) {
        const plan = updated.get(consumer) ?? consumers.get(consumer);
        if (plan === undefined) continue;
        const nested = plan.mounts.find((candidate) => candidate.target.startsWith(`${mount.target}/`));
        if (nested !== undefined) {
          const entry = input.plannedServiceDrafts.find((draft) => draft.name === consumer);
          const relativeTarget = posix.relative(app.target, mount.target);
          const storage = entry?.draft.normalizedConfig.storage?.some((item) =>
            typeof item === "string"
              ? posix.normalize(item) === nested.target
              : posix.normalize(item.target) === nested.target,
          );
          return conflict(
            ["services", consumer, storage ? "storage" : "mounts"],
            `Mount ${nested.target} overlays part of the managed dependency environment at ${mount.target}.`,
            `Remove the nested mount or opt out by mounting ${mount.target} directly or adding ${relativeTarget} to appMount.includes.`,
          );
        }
        updated.set(consumer, {
          ...plan,
          dependsOn: [
            ...plan.dependsOn,
            { service: name, condition: "service_completed_successfully", required: true },
          ],
        });
      }
    }
    return updated;
  };
  return { prepare, finish, stores, consumers };
};

export const withDependencyEnvironmentJobs = (
  services: Readonly<Record<string, ServicePlan>>,
  selected: readonly string[],
) => {
  const names = new Set(selected);
  for (const service of selected) {
    for (const { service: dependency } of services[service]?.dependsOn ?? []) {
      if (
        Schema.is(DependencyEnvironmentJob)(
          services[dependency]?.extensions[DEPENDENCY_ENVIRONMENT_EXTENSION_KEY],
        )
      )
        names.add(dependency);
    }
  }
  return [...names];
};

export const isDependencyEnvironmentStore = (
  plan: { readonly services: Readonly<Record<string, ServicePlan>> },
  consumer: ServicePlan,
  volume: { readonly store: string; readonly target: string },
) =>
  consumer.dependsOn.some((edge) => {
    if (edge.condition !== "service_completed_successfully" || !edge.required) return false;
    const job = plan.services[edge.service];
    if (job === undefined) return false;
    const intent = job.extensions[DEPENDENCY_ENVIRONMENT_EXTENSION_KEY];
    return (
      Schema.is(DependencyEnvironmentJob)(intent) &&
      intent.consumers.includes(consumer.name) &&
      job.mounts.some(
        (mount) => mount.type === "volume" && mount.store === volume.store && mount.target === volume.target,
      )
    );
  });
