import { Effect, Stream } from "effect";
import { LANDO_DB_ENV_KEYS } from "../database-creds/index.ts";
import { VolumeOperationError } from "../errors/index.ts";
import {
  type AppPlan,
  LANDO_DATA_ROOT_LABEL,
  type PortablePath,
  type ServicePlan,
  type VolumeInfo,
  type VolumeRef,
  planAppIdentity,
  planDataId,
} from "../schema/index.ts";
import type { CommandSpec, ExecChunk, ExecTarget, RuntimeProviderShape } from "../services/index.ts";
import { TEST_PROVIDER_ID, utf8 } from "./_shared.ts";

type Environment = Readonly<Record<string, string>>;
type MountedVolume = {
  readonly info: VolumeInfo;
  readonly database: ServicePlan["connection"];
  readonly initialEnvironment: Environment | undefined;
};

export const testVolumeLocator = (ref: Pick<VolumeRef, "store">) => ({
  coordinationKey: JSON.stringify(["endpoint:test", ref.store]),
  nativeName: ref.store,
});

export const makeTestProviderServiceVolumes = () => {
  const volumes = new Map<string, MountedVolume>();
  const mounted = new Map<string, ReadonlyMap<PortablePath, MountedVolume>>();
  const attach = (input: {
    readonly plan: AppPlan;
    readonly service: ServicePlan;
    readonly containerId: string;
    readonly environment: Environment | undefined;
  }) => {
    const { plan, service, containerId, environment } = input;
    if (mounted.has(containerId)) return;
    const bindings = new Map<PortablePath, MountedVolume>();
    for (const mount of service.mounts) {
      if (mount.type !== "volume" || mount.subpath !== undefined) continue;
      const store = plan.stores.find((entry) => entry.name === mount.store);
      if (store?.kind !== "data" || store.scope !== "service") continue;
      const ref = { app: planDataId(plan), store: store.name, scope: store.scope };
      const key = testVolumeLocator(ref).coordinationKey;
      let volume = volumes.get(key);
      if (volume === undefined) {
        const generation = crypto.randomUUID();
        volume = {
          info: {
            ref,
            instanceId: generation,
            provenance: "known",
            identity: {
              ...testVolumeLocator(ref),
              generation,
              ownerRoot: planAppIdentity(plan).appRoot,
              origin: "created",
            },
            ...(plan.identity?.dataRoot === undefined
              ? {}
              : { labels: { [LANDO_DATA_ROOT_LABEL]: plan.identity.dataRoot } }),
          },
          database: service.connection,
          initialEnvironment: environment,
        };
        volumes.set(key, volume);
      }
      bindings.set(mount.target, volume);
    }
    mounted.set(containerId, bindings);
  };
  return {
    attach,
    forget: (containerId: string) => mounted.delete(containerId),
    purge: (app: AppPlan["id"]) => {
      for (const [key, volume] of volumes) if (volume.info.ref.app === app) volumes.delete(key);
    },
    observe: (
      target: Parameters<NonNullable<RuntimeProviderShape["observeBoundVolume"]>>[0],
      containerId: string,
      destination: PortablePath,
    ) => {
      const volume = mounted.get(containerId)?.get(destination);
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
        [...(mounted.get(containerId)?.values() ?? [])].some(
          ({ database, initialEnvironment }) =>
            database !== undefined &&
            initialEnvironment?.[LANDO_DB_ENV_KEYS.password] !== undefined &&
            env.FAMILY === database.family &&
            env.PORT === String(database.port) &&
            env.USER_NAME === initialEnvironment[LANDO_DB_ENV_KEYS.user] &&
            env.DATABASE === initialEnvironment[LANDO_DB_ENV_KEYS.database] &&
            env.PASSWORD === initialEnvironment[LANDO_DB_ENV_KEYS.password] &&
            env.ROOT_PASSWORD === (initialEnvironment[LANDO_DB_ENV_KEYS.rootPassword] ?? "") &&
            (database.family === "postgres" ? env.ADMIN_PASSWORD === "" : Boolean(env.ADMIN_PASSWORD)),
        );
      return matched
        ? Stream.make({ kind: "stdout", chunk: utf8("lando-matched\n") }, { exitCode: 0 })
        : Stream.make({ exitCode: 1 });
    },
  };
};
