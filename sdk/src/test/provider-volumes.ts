import { Effect, Stream } from "effect";
import { LANDO_DB_ENV_KEYS } from "../database-creds/index.ts";
import { VolumeOperationError } from "../errors/index.ts";
import {
  AbsolutePath,
  type AppPlan,
  LANDO_DATA_ROOT_LABEL,
  type PortablePath,
  type ServicePlan,
  type VolumeIdentity,
  type VolumeInfo,
  type VolumeRef,
  planAppIdentity,
  planDataId,
} from "../schema/index.ts";
import type { CommandSpec, ExecChunk, ExecTarget, RuntimeProviderShape } from "../services/index.ts";
import { TEST_PROVIDER_ID, utf8 } from "./_shared.ts";

type Environment = Readonly<Record<string, string>>;
type TestVolume = {
  readonly info: VolumeInfo & { readonly identity: VolumeIdentity };
  readonly database: ServicePlan["connection"];
  readonly initialEnvironment: Environment | undefined;
  fileBytes?: Uint8Array;
  treeBytes?: Uint8Array;
};
type VolumeBinding = {
  readonly ref: VolumeRef;
  readonly generation: string;
};

const appScope = "app";
const locator = (ref: VolumeRef) => ({
  coordinationKey: JSON.stringify(["endpoint:test", ref.app, ref.scope ?? appScope, ref.store]),
  nativeName: ref.store,
});
const testVolumeRoot = AbsolutePath.make("/tmp/lando-sdk-test");

export const makeTestProviderVolumes = () => {
  const volumes = new Map<string, TestVolume>();
  const mounted = new Map<string, ReadonlyMap<PortablePath, VolumeBinding>>();
  const get = (ref: VolumeRef) => volumes.get(locator(ref).coordinationKey);
  const currentVolume = (binding: VolumeBinding) => {
    const volume = get(binding.ref);
    return volume?.info.identity.generation === binding.generation ? volume : undefined;
  };
  const ensure = (
    ref: VolumeRef,
    boot?: {
      readonly plan: AppPlan;
      readonly service: ServicePlan;
      readonly environment: Environment | undefined;
    },
  ) => {
    const location = locator(ref);
    const current = volumes.get(location.coordinationKey);
    if (current !== undefined) return current;
    const generation = crypto.randomUUID();
    const dataRoot = boot?.plan.identity?.dataRoot;
    const created: TestVolume = {
      info: {
        ref: { ...ref, scope: ref.scope ?? appScope },
        instanceId: generation,
        provenance: "known",
        identity: {
          ...location,
          generation,
          ownerRoot: boot === undefined ? testVolumeRoot : planAppIdentity(boot.plan).appRoot,
          origin: "created",
        },
        ...(dataRoot === undefined ? {} : { labels: { [LANDO_DATA_ROOT_LABEL]: dataRoot } }),
      },
      database: boot?.service.connection,
      initialEnvironment: boot?.environment,
    };
    volumes.set(location.coordinationKey, created);
    return created;
  };
  const attach = (input: {
    readonly plan: AppPlan;
    readonly service: ServicePlan;
    readonly containerId: string;
    readonly environment: Environment | undefined;
  }) => {
    const { plan, service, containerId } = input;
    const current = mounted.get(containerId);
    if (
      current !== undefined &&
      [...current.values()].every((binding) => currentVolume(binding) !== undefined)
    )
      return;
    const bindings = new Map<PortablePath, VolumeBinding>();
    for (const mount of service.mounts) {
      if (mount.type !== "volume" || mount.subpath !== undefined) continue;
      const store = plan.stores.find((entry) => entry.name === mount.store);
      if (store?.kind !== "data" || store.scope !== "service") continue;
      const ref = { app: planDataId(plan), store: store.name, scope: store.scope };
      const { info } = ensure(ref, input);
      bindings.set(mount.target, { ref: info.ref, generation: info.identity.generation });
    }
    mounted.set(containerId, bindings);
  };
  return {
    attach,
    get,
    ensure,
    list: (filter: Parameters<RuntimeProviderShape["listVolumes"]>[0]) =>
      [...volumes.values()]
        .map(({ info }) => info)
        .filter(
          ({ ref, labels }) =>
            (filter.app === undefined || ref.app === filter.app) &&
            (filter.store === undefined || ref.store === filter.store) &&
            (filter.scope === undefined || ref.scope === filter.scope) &&
            Object.entries(filter.labels ?? {}).every(([key, value]) => labels?.[key] === value),
        ),
    locate: (ref: VolumeRef) => {
      const volume = get(ref);
      return volume === undefined
        ? { ...locator(ref), presence: "absent" as const }
        : {
            ...locator(ref),
            presence: "present" as const,
            identity: volume.info.identity,
            ...(volume.info.labels === undefined ? {} : { labels: volume.info.labels }),
          };
    },
    remove: (ref: VolumeRef, expectedGeneration: string) =>
      Effect.suspend(() => {
        const volume = get(ref);
        if (volume === undefined) return Effect.void;
        if (volume.info.identity.generation !== expectedGeneration)
          return Effect.fail(
            new VolumeOperationError({
              providerId: TEST_PROVIDER_ID,
              operation: "removeVolume",
              store: ref.store,
              message: "The target volume was replaced.",
              remediation: "Inspect the current volume before retrying.",
            }),
          );
        volumes.delete(volume.info.identity.coordinationKey);
        return Effect.void;
      }),
    forget: (containerId: string) => mounted.delete(containerId),
    purge: (app: AppPlan["id"]) => {
      for (const [key, volume] of volumes) if (volume.info.ref.app === app) volumes.delete(key);
    },
    observe: (
      target: Parameters<NonNullable<RuntimeProviderShape["observeBoundVolume"]>>[0],
      containerId: string,
      destination: PortablePath,
    ) => {
      const binding = mounted.get(containerId)?.get(destination);
      const volume = binding === undefined ? undefined : currentVolume(binding);
      return target.expectedContainerId === containerId && volume !== undefined
        ? Effect.succeed(volume.info)
        : Effect.fail(
            new VolumeOperationError({
              providerId: TEST_PROVIDER_ID,
              operation: "observeBoundVolume",
              message: `Could not observe the expected volume mount for ${target.service}.`,
              remediation: "Apply a service with a private data volume and observe its current container.",
            }),
          );
    },
    // Reader-path guides run without a database server. Model an already provisioned
    // stock database, not credential writes; only a bound probe with matching inputs succeeds.
    probe: (
      target: ExecTarget,
      containerId: string,
      command: CommandSpec,
    ): Stream.Stream<ExecChunk> | undefined => {
      if (
        target.expectedContainerId === undefined ||
        command.command[0] !== "sh" ||
        command.command[1] !== "-ec" ||
        command.command[2]?.endsWith("\nprintf 'lando-matched\\n'") !== true
      )
        return undefined;
      const { env } = command;
      const matched =
        target.expectedContainerId === containerId &&
        env !== undefined &&
        [...(mounted.get(containerId)?.values() ?? [])].some((binding) => {
          const volume = currentVolume(binding);
          if (volume === undefined) return false;
          const { database, initialEnvironment } = volume;
          return (
            database !== undefined &&
            initialEnvironment?.[LANDO_DB_ENV_KEYS.password] !== undefined &&
            env.FAMILY === database.family &&
            env.PORT === String(database.port) &&
            env.USER_NAME === initialEnvironment[LANDO_DB_ENV_KEYS.user] &&
            env.DATABASE === initialEnvironment[LANDO_DB_ENV_KEYS.database] &&
            env.PASSWORD === initialEnvironment[LANDO_DB_ENV_KEYS.password] &&
            env.ROOT_PASSWORD === (initialEnvironment[LANDO_DB_ENV_KEYS.rootPassword] ?? "") &&
            (database.family === "postgres" ? env.ADMIN_PASSWORD === "" : Boolean(env.ADMIN_PASSWORD))
          );
        });
      return matched
        ? Stream.make({ kind: "stdout", chunk: utf8("lando-matched\n") }, { exitCode: 0 })
        : Stream.make({ exitCode: 1 });
    },
  };
};
