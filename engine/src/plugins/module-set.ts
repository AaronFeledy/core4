import { Either } from "effect";

import { PluginDescriptorMismatchError } from "@lando/sdk/errors";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import type { PluginManifest } from "@lando/sdk/schema";

type MapSlot =
  | "runtimeProviders"
  | "commands"
  | "renderers"
  | "fileSyncEngines"
  | "templateEngines"
  | "certificateAuthorities"
  | "proxyServices"
  | "sshServices"
  | "globalServices"
  | "serviceTypes"
  | "serviceFeatures"
  | "appFeatures"
  | "loggers"
  | "subscriberFactoryLoaders";

type SlotMap<Slot extends MapSlot> = NonNullable<LandoPluginModule[Slot]>;
type MapKey<MapType> = MapType extends ReadonlyMap<infer Key, unknown> ? Key : never;
type MapValue<MapType> = MapType extends ReadonlyMap<unknown, infer Value> ? Value : never;
type HostMaintainer = NonNullable<LandoPluginModule["hostMaintainers"]>[number];
type DoctorCheck = NonNullable<LandoPluginModule["doctorChecks"]>[number];

export interface PluginCapabilityIndex {
  readonly runtimeProviders: SlotMap<"runtimeProviders">;
  readonly commands: SlotMap<"commands">;
  readonly renderers: SlotMap<"renderers">;
  readonly fileSyncEngines: SlotMap<"fileSyncEngines">;
  readonly templateEngines: SlotMap<"templateEngines">;
  readonly certificateAuthorities: SlotMap<"certificateAuthorities">;
  readonly proxyServices: SlotMap<"proxyServices">;
  readonly sshServices: SlotMap<"sshServices">;
  readonly globalServices: SlotMap<"globalServices">;
  readonly serviceTypes: SlotMap<"serviceTypes">;
  readonly serviceFeatures: SlotMap<"serviceFeatures">;
  readonly appFeatures: SlotMap<"appFeatures">;
  readonly loggers: SlotMap<"loggers">;
  readonly subscriberFactoryLoaders: SlotMap<"subscriberFactoryLoaders">;
  readonly hostMaintainers: ReadonlyMap<string, HostMaintainer>;
  readonly doctorChecks: ReadonlyMap<string, DoctorCheck>;
  readonly manifests: ReadonlyArray<PluginManifest>;
}

interface ContributionRefLike {
  readonly id: string;
}

interface AddContributionsInput<Key, Value> {
  readonly target: Map<Key, Value>;
  readonly entries: Iterable<readonly [Key, Value]>;
  readonly pluginName: string;
  readonly kind: string;
}

const mutableMapFor = <Slot extends MapSlot>(): Map<MapKey<SlotMap<Slot>>, MapValue<SlotMap<Slot>>> =>
  new Map();

const idsOf = (
  contributions: ReadonlyArray<string | ContributionRefLike> | undefined,
): ReadonlyArray<string> =>
  contributions?.map((contribution) => (typeof contribution === "string" ? contribution : contribution.id)) ??
  [];

const keysOf = (contributions: ReadonlyMap<unknown, unknown> | undefined): ReadonlyArray<string> =>
  contributions === undefined ? [] : [...contributions.keys()].map(String);

const sameIds = (declared: ReadonlyArray<string>, provided: ReadonlyArray<string>): boolean => {
  const left = [...declared].sort();
  const right = [...provided].sort();
  return left.length === right.length && left.every((id, index) => id === right[index]);
};

const validateDescriptorIds = (
  module: LandoPluginModule,
  kind: string,
  declared: ReadonlyArray<string>,
  provided: ReadonlyArray<string>,
): PluginDescriptorMismatchError | undefined =>
  sameIds(declared, provided)
    ? undefined
    : new PluginDescriptorMismatchError({
        pluginName: module.name,
        kind,
        declared,
        provided,
        message: `Plugin ${module.name} manifest and descriptor disagree for ${kind}.`,
        remediation: `Align ${module.name}'s manifest ${kind} ids with its descriptor ${kind} ids.`,
      });

const descriptorMismatch = (module: LandoPluginModule): PluginDescriptorMismatchError | undefined => {
  const contributes = module.manifest.contributes;
  return [
    validateDescriptorIds(
      module,
      "providers",
      idsOf(contributes?.providers),
      keysOf(module.runtimeProviders),
    ),
    validateDescriptorIds(module, "commands", idsOf(contributes?.commands), keysOf(module.commands)),
    validateDescriptorIds(module, "renderers", idsOf(contributes?.renderers), keysOf(module.renderers)),
    validateDescriptorIds(
      module,
      "fileSyncEngines",
      idsOf(contributes?.fileSyncEngines),
      keysOf(module.fileSyncEngines),
    ),
    validateDescriptorIds(
      module,
      "templateEngines",
      idsOf(contributes?.templateEngines),
      keysOf(module.templateEngines),
    ),
    validateDescriptorIds(
      module,
      "certificateAuthorities",
      idsOf(contributes?.certificateAuthorities),
      keysOf(module.certificateAuthorities),
    ),
    validateDescriptorIds(
      module,
      "proxyServices",
      idsOf(contributes?.proxyServices),
      keysOf(module.proxyServices),
    ),
    validateDescriptorIds(
      module,
      "globalServices",
      idsOf(contributes?.globalServices),
      keysOf(module.globalServices),
    ),
    validateDescriptorIds(
      module,
      "serviceTypes",
      idsOf(contributes?.serviceTypes),
      keysOf(module.serviceTypes),
    ),
    validateDescriptorIds(
      module,
      "serviceFeatures",
      idsOf(contributes?.serviceFeatures),
      keysOf(module.serviceFeatures),
    ),
    validateDescriptorIds(module, "appFeatures", idsOf(contributes?.appFeatures), keysOf(module.appFeatures)),
    validateDescriptorIds(module, "loggers", idsOf(contributes?.loggers), keysOf(module.loggers)),
    validateDescriptorIds(
      module,
      "subscribers",
      idsOf(module.manifest.subscribers),
      keysOf(module.subscriberFactoryLoaders),
    ),
  ].find((error) => error !== undefined);
};

const addContributions = <Key, Value>(
  input: AddContributionsInput<Key, Value>,
): PluginDescriptorMismatchError | undefined => {
  for (const [id, contribution] of input.entries) {
    if (input.target.has(id)) {
      return new PluginDescriptorMismatchError({
        pluginName: input.pluginName,
        kind: input.kind,
        declared: [String(id)],
        provided: [String(id)],
        message: `Plugin ${input.pluginName} duplicates ${input.kind} id ${String(id)}.`,
        remediation: `Rename or remove the duplicate ${input.kind} contribution ${String(id)}.`,
      });
    }
    input.target.set(id, contribution);
  }
  return undefined;
};

const capabilityIndexCache = new WeakMap<
  ReadonlyArray<LandoPluginModule>,
  Either.Either<PluginCapabilityIndex, PluginDescriptorMismatchError>
>();

export const makePluginCapabilityIndex = (
  modules: ReadonlyArray<LandoPluginModule>,
): Either.Either<PluginCapabilityIndex, PluginDescriptorMismatchError> => {
  const cached = capabilityIndexCache.get(modules);
  if (cached !== undefined) return cached;
  const computed = computePluginCapabilityIndex(modules);
  capabilityIndexCache.set(modules, computed);
  return computed;
};

const computePluginCapabilityIndex = (
  modules: ReadonlyArray<LandoPluginModule>,
): Either.Either<PluginCapabilityIndex, PluginDescriptorMismatchError> => {
  const runtimeProviders = mutableMapFor<"runtimeProviders">();
  const commands = mutableMapFor<"commands">();
  const renderers = mutableMapFor<"renderers">();
  const fileSyncEngines = mutableMapFor<"fileSyncEngines">();
  const templateEngines = mutableMapFor<"templateEngines">();
  const certificateAuthorities = mutableMapFor<"certificateAuthorities">();
  const proxyServices = mutableMapFor<"proxyServices">();
  const sshServices = mutableMapFor<"sshServices">();
  const globalServices = mutableMapFor<"globalServices">();
  const serviceTypes = mutableMapFor<"serviceTypes">();
  const serviceFeatures = mutableMapFor<"serviceFeatures">();
  const appFeatures = mutableMapFor<"appFeatures">();
  const loggers = mutableMapFor<"loggers">();
  const subscriberFactoryLoaders = mutableMapFor<"subscriberFactoryLoaders">();
  const hostMaintainers = new Map<string, HostMaintainer>();
  const doctorChecks = new Map<string, DoctorCheck>();

  for (const module of modules) {
    const mismatch = descriptorMismatch(module);
    if (mismatch !== undefined) return Either.left(mismatch);

    const add = <Key, Value>(
      target: Map<Key, Value>,
      entries: Iterable<readonly [Key, Value]>,
      kind: string,
    ): PluginDescriptorMismatchError | undefined =>
      addContributions({ target, entries, pluginName: module.name, kind });
    const additions = [
      add(runtimeProviders, module.runtimeProviders ?? [], "providers"),
      add(commands, module.commands ?? [], "commands"),
      add(renderers, module.renderers ?? [], "renderers"),
      add(fileSyncEngines, module.fileSyncEngines ?? [], "fileSyncEngines"),
      add(templateEngines, module.templateEngines ?? [], "templateEngines"),
      add(certificateAuthorities, module.certificateAuthorities ?? [], "certificateAuthorities"),
      add(proxyServices, module.proxyServices ?? [], "proxyServices"),
      add(sshServices, module.sshServices ?? [], "sshServices"),
      add(globalServices, module.globalServices ?? [], "globalServices"),
      add(serviceTypes, module.serviceTypes ?? [], "serviceTypes"),
      add(serviceFeatures, module.serviceFeatures ?? [], "serviceFeatures"),
      add(appFeatures, module.appFeatures ?? [], "appFeatures"),
      add(loggers, module.loggers ?? [], "loggers"),
      add(subscriberFactoryLoaders, module.subscriberFactoryLoaders ?? [], "subscribers"),
      add(
        hostMaintainers,
        module.hostMaintainers?.map((entry) => [entry.id, entry] as const) ?? [],
        "hostMaintainers",
      ),
      add(
        doctorChecks,
        module.doctorChecks?.map((entry) => [entry.id, entry] as const) ?? [],
        "doctorChecks",
      ),
    ];
    const duplicate = additions.find((error) => error !== undefined);
    if (duplicate !== undefined) return Either.left(duplicate);
  }

  return Either.right({
    runtimeProviders,
    commands,
    renderers,
    fileSyncEngines,
    templateEngines,
    certificateAuthorities,
    proxyServices,
    sshServices,
    globalServices,
    serviceTypes,
    serviceFeatures,
    appFeatures,
    loggers,
    subscriberFactoryLoaders,
    hostMaintainers,
    doctorChecks,
    manifests: modules.map((module) => module.manifest),
  });
};
