import { dirname } from "node:path";

import { Effect, Schema } from "effect";

import {
  LandofileNotFoundError,
  LandofileParseError,
  RemoteDatasetUnsupportedError,
  RemoteProtectedEnvError,
  RemoteProviderUnavailableError,
} from "@lando/sdk/errors";
import { emitLandofileYaml } from "@lando/sdk/landofile";
import {
  type AppPlan,
  type DataEndpoint,
  type DatasetKind,
  LandofileShape,
  RemoteConfig,
  type RemoteConfig as RemoteConfigType,
  RemoteEnvironment,
  type RemoteEnvironment as RemoteEnvironmentType,
  type RemoteTestResult,
  SyncResult,
  type SyncResult as SyncResultType,
  type VolumeRef,
} from "@lando/sdk/schema";
import {
  AppPlanner,
  DataMover,
  Dataset,
  InteractionService,
  LandofileService,
  RemoteSource,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import { findLandofilePath } from "../../landofile/discovery.ts";
import { parseLandofile } from "../../landofile/parser.ts";
import { type ResolvedAppTarget, loadUserLandofileAt } from "../app-resolution.ts";

export const RemoteEntrySchema = Schema.Struct({ name: Schema.String, config: RemoteConfig });
export const RemoteListResultSchema = Schema.Array(RemoteEntrySchema);
export const RemoteMutationResultSchema = Schema.Struct({
  app: Schema.String,
  remote: Schema.String,
  file: Schema.String,
  config: RemoteConfig,
});
export const RemoteEnvListResultSchema = Schema.Array(RemoteEnvironment);

export interface RemoteEntry {
  readonly name: string;
  readonly config: RemoteConfigType;
}

export interface RemoteMutationResult {
  readonly app: string;
  readonly remote: string;
  readonly file: string;
  readonly config: RemoteConfigType;
}

export interface RemoteSyncOptions {
  readonly cwd?: string;
  readonly remote?: string;
  readonly env?: string;
  readonly only?: ReadonlyArray<string>;
  readonly noSnapshot?: boolean;
  readonly force?: boolean;
  readonly yes?: boolean;
  readonly noInteractive?: boolean;
}

export interface RemoteListOptions {
  readonly cwd?: string;
  readonly format?: "text" | "json";
}

export interface RemoteAddOptions {
  readonly cwd?: string;
  readonly name: string;
  readonly config: RemoteConfigType;
  readonly format?: "text" | "json";
}

export interface RemoteRemoveOptions {
  readonly cwd?: string;
  readonly name: string;
  readonly format?: "text" | "json";
}

export interface RemoteTestOptions {
  readonly cwd?: string;
  readonly remote?: string;
  readonly env?: string;
  readonly format?: "text" | "json";
}

export interface RemoteEnvListOptions extends RemoteTestOptions {}
export interface RemoteSetupOptions extends RemoteTestOptions {
  readonly force?: boolean;
}

export type RemoteSyncCommandError = unknown;

type RemoteSyncServices = LandofileService | RuntimeProviderRegistry | AppPlanner;

interface LoadedRemoteLandofile {
  readonly file: string;
  readonly root: string;
  readonly landofile: typeof LandofileShape.Type;
}

const decodeLandofile = Schema.decodeUnknownEither(LandofileShape);

const unavailable = (requested?: string): RemoteProviderUnavailableError =>
  new RemoteProviderUnavailableError({
    message:
      requested === undefined
        ? "No RemoteSource is installed."
        : `No RemoteSource is installed for ${requested}.`,
    ...(requested === undefined ? {} : { requested }),
    installOptions: [
      "lando plugin:add <remote-source-plugin>",
      "lando setup --provider=<provider-with-remotes>",
    ],
    remediation:
      "Install a RemoteSource plugin for this remote, then rerun the command. Bundled remotes ship in Lando 4.1.",
  });

const loadRemoteLandofile = (
  cwd = process.cwd(),
): Effect.Effect<LoadedRemoteLandofile, LandofileNotFoundError | LandofileParseError> =>
  Effect.gen(function* () {
    const file = yield* Effect.promise(() => findLandofilePath(cwd));
    if (file === undefined) {
      return yield* Effect.fail(
        new LandofileNotFoundError({
          message: "No .lando.yml found. Run `lando init` before configuring remotes.",
          cwd,
        }),
      );
    }
    const root = dirname(file);
    const content = yield* Effect.tryPromise({
      try: () => Bun.file(file).text(),
      catch: (cause) =>
        new LandofileParseError({
          message: `Could not read ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
          filePath: file,
          line: undefined,
          column: undefined,
          cause,
        }),
    });
    const parsed = yield* parseLandofile({ file, content, cwd: root });
    const decoded = decodeLandofile(parsed, { onExcessProperty: "error" });
    if (decoded._tag === "Left") {
      return yield* Effect.fail(
        new LandofileParseError({
          message: `Landofile ${file} is not valid: ${String(decoded.left)}`,
          filePath: file,
          line: undefined,
          column: undefined,
          cause: decoded.left,
        }),
      );
    }
    return { file, root, landofile: decoded.right };
  });

const writeLandofile = (file: string, landofile: typeof LandofileShape.Type) =>
  Effect.tryPromise({
    try: () => Bun.write(file, emitLandofileYaml(landofile)),
    catch: (cause) =>
      new LandofileParseError({
        message: `Could not write ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
        filePath: file,
        line: undefined,
        column: undefined,
        cause,
      }),
  });

const remoteEntries = (landofile: typeof LandofileShape.Type): ReadonlyArray<RemoteEntry> =>
  Object.entries(landofile.remotes ?? {}).map(([name, config]) => ({ name, config }));

const chooseRemote = (
  landofile: typeof LandofileShape.Type,
  requested: string | undefined,
): Effect.Effect<RemoteEntry, RemoteProviderUnavailableError> => {
  const entries = remoteEntries(landofile);
  const match = requested === undefined ? entries[0] : entries.find((entry) => entry.name === requested);
  if (match !== undefined) return Effect.succeed(match);
  return Effect.fail(unavailable(requested));
};

const resolveRemoteSource = (entry: RemoteEntry) =>
  Effect.gen(function* () {
    const sourceOption = yield* Effect.serviceOption(RemoteSource);
    if (sourceOption._tag === "None") return yield* Effect.fail(unavailable(entry.config.source));
    const source = sourceOption.value;
    if (source.id !== entry.config.source) return yield* Effect.fail(unavailable(entry.config.source));
    return source;
  });

const resolvePlan = (
  cwd: string | undefined,
  target: ResolvedAppTarget | undefined,
): Effect.Effect<AppPlan, RemoteSyncCommandError, RemoteSyncServices> => {
  if (target !== undefined) return Effect.succeed(target.plan);
  return Effect.gen(function* () {
    const landofileService = yield* LandofileService;
    const registry = yield* RuntimeProviderRegistry;
    const planner = yield* AppPlanner;
    const landofile = yield* loadUserLandofileAt(landofileService, cwd ?? process.cwd());
    const capabilities = yield* registry.capabilities;
    return yield* planner.plan(landofile, capabilities);
  });
};

const datasetKinds = (
  sourceDatasets: ReadonlyArray<DatasetKind>,
  requested: ReadonlyArray<string> | undefined,
): ReadonlyArray<DatasetKind> => {
  if (requested === undefined || requested.length === 0) return sourceDatasets;
  return requested.filter(
    (kind): kind is DatasetKind =>
      kind === "database" || kind === "files" || kind === "config" || kind === "blob",
  );
};

const datasetContext = (plan: AppPlan, kind: DatasetKind, landofile: typeof LandofileShape.Type) => ({
  app: plan.id,
  plan,
  ...(landofile.sync?.[kind]?.service === undefined ? {} : { service: landofile.sync[kind].service }),
  ...(landofile.sync?.[kind] === undefined ? {} : { binding: landofile.sync[kind] }),
});

const confirmDestructive = (message: string, options: RemoteSyncOptions) =>
  Effect.gen(function* () {
    if (options.yes === true || options.noInteractive === true) return;
    const interaction = yield* Effect.serviceOption(InteractionService);
    if (interaction._tag === "None") return;
    const confirmed = yield* Effect.scoped(
      interaction.value.confirm({ message, default: false, mode: "interactive" }),
    );
    if (!confirmed) {
      return yield* Effect.fail(
        new RemoteProtectedEnvError({
          message: "Remote sync was not confirmed.",
          remediation: "Re-run with -y/--yes after verifying the selected remote and environment.",
        }),
      );
    }
  });

const snapshotBeforeApply = (store: VolumeRef | null, options: RemoteSyncOptions) =>
  Effect.gen(function* () {
    if (store === null || options.noSnapshot === true) return undefined;
    const dataMover = yield* Effect.serviceOption(DataMover);
    if (dataMover._tag === "None") return undefined;
    return yield* Effect.scoped(dataMover.value.snapshot(store));
  });

export const appRemoteList = (
  options: RemoteListOptions = {},
): Effect.Effect<ReadonlyArray<RemoteEntry>, LandofileNotFoundError | LandofileParseError> =>
  loadRemoteLandofile(options.cwd).pipe(Effect.map(({ landofile }) => remoteEntries(landofile)));

export const appRemoteAdd = (
  options: RemoteAddOptions,
): Effect.Effect<RemoteMutationResult, LandofileNotFoundError | LandofileParseError> =>
  Effect.gen(function* () {
    const loaded = yield* loadRemoteLandofile(options.cwd);
    const remotes = { ...(loaded.landofile.remotes ?? {}), [options.name]: options.config };
    const next = { ...loaded.landofile, remotes };
    yield* writeLandofile(loaded.file, next);
    return { app: next.name ?? "app", remote: options.name, file: loaded.file, config: options.config };
  });

export const appRemoteRemove = (
  options: RemoteRemoveOptions,
): Effect.Effect<
  RemoteMutationResult,
  LandofileNotFoundError | LandofileParseError | RemoteProviderUnavailableError
> =>
  Effect.gen(function* () {
    const loaded = yield* loadRemoteLandofile(options.cwd);
    const existing = loaded.landofile.remotes?.[options.name];
    if (existing === undefined) return yield* Effect.fail(unavailable(options.name));
    const { [options.name]: _removed, ...remotes } = loaded.landofile.remotes ?? {};
    const next = { ...loaded.landofile, remotes };
    yield* writeLandofile(loaded.file, next);
    return { app: next.name ?? "app", remote: options.name, file: loaded.file, config: existing };
  });

export const appRemoteEnvList = (
  options: RemoteEnvListOptions = {},
): Effect.Effect<ReadonlyArray<RemoteEnvironmentType>, RemoteSyncCommandError> =>
  Effect.gen(function* () {
    const loaded = yield* loadRemoteLandofile(options.cwd);
    const entry = yield* chooseRemote(loaded.landofile, options.remote);
    const source = yield* resolveRemoteSource(entry);
    return yield* source.listEnvironments(entry.config);
  });

export const appRemoteTest = (
  options: RemoteTestOptions = {},
): Effect.Effect<RemoteTestResult, RemoteSyncCommandError> =>
  Effect.gen(function* () {
    const loaded = yield* loadRemoteLandofile(options.cwd);
    const entry = yield* chooseRemote(loaded.landofile, options.remote);
    const source = yield* resolveRemoteSource(entry);
    if (source.test !== undefined) return yield* source.test(entry.config, options.env);
    const environments = yield* source.listEnvironments(entry.config);
    const env =
      options.env ?? environments.find((candidate) => candidate.default === true)?.id ?? environments[0]?.id;
    return {
      ok: env !== undefined,
      ...(env === undefined ? {} : { env }),
      message: "RemoteSource resolved.",
    };
  });

export const appRemoteSetup = (options: RemoteSetupOptions = {}) => appRemoteTest(options);

export const appPull = (
  options: RemoteSyncOptions = {},
  target?: ResolvedAppTarget,
): Effect.Effect<SyncResultType, RemoteSyncCommandError, RemoteSyncServices> =>
  Effect.gen(function* () {
    const loaded = yield* loadRemoteLandofile(options.cwd ?? target?.root);
    const entry = yield* chooseRemote(loaded.landofile, options.remote);
    const source = yield* resolveRemoteSource(entry);
    const dataset = yield* Effect.serviceOption(Dataset);
    if (dataset._tag === "None") return yield* Effect.fail(unavailable("Dataset"));
    const kinds = datasetKinds(source.capabilities.datasets, options.only);
    const env = options.env ?? "dev";
    const plan = yield* resolvePlan(options.cwd, target);
    const artifacts: DataEndpoint[] = [];
    const snapshots = [];
    let changed = false;
    yield* confirmDestructive(`Pull ${kinds.join(", ")} from ${entry.name}@${env}?`, options);
    for (const kind of kinds) {
      if (dataset.value.kind !== kind) {
        return yield* Effect.fail(
          new RemoteDatasetUnsupportedError({
            message: "No Dataset is installed for the requested kind.",
            dataset: kind,
          }),
        );
      }
      const locator = yield* source.resolve(entry.config, env, kind);
      const artifact = yield* Effect.scoped(source.fetch(locator, { force: options.force }));
      artifacts.push(artifact);
      const ctx = datasetContext(plan, kind, loaded.landofile);
      const localStore = yield* dataset.value.localStore(ctx);
      const snapshot = yield* snapshotBeforeApply(localStore, options);
      if (snapshot !== undefined) snapshots.push(snapshot);
      const applied = yield* Effect.scoped(
        dataset.value.apply(ctx, artifact, { force: options.force, snapshot: options.noSnapshot !== true }),
      );
      changed = changed || applied.changed;
    }
    return { direction: "pull", remote: entry.name, env, datasets: kinds, changed, artifacts, snapshots };
  });

export const appPush = (
  options: RemoteSyncOptions = {},
  target?: ResolvedAppTarget,
): Effect.Effect<SyncResultType, RemoteSyncCommandError, RemoteSyncServices> =>
  Effect.gen(function* () {
    const loaded = yield* loadRemoteLandofile(options.cwd ?? target?.root);
    const entry = yield* chooseRemote(loaded.landofile, options.remote);
    const source = yield* resolveRemoteSource(entry);
    if (!source.capabilities.push) {
      return yield* Effect.fail(
        new RemoteDatasetUnsupportedError({
          message: "RemoteSource does not support push.",
          remote: entry.name,
        }),
      );
    }
    const dataset = yield* Effect.serviceOption(Dataset);
    if (dataset._tag === "None") return yield* Effect.fail(unavailable("Dataset"));
    const kinds = datasetKinds(source.capabilities.datasets, options.only);
    const env = options.env ?? "dev";
    if (source.capabilities.protectedByDefault?.includes(env) === true && options.force !== true) {
      return yield* Effect.fail(
        new RemoteProtectedEnvError({
          message: `Environment ${env} is protected and requires --force before push.`,
          remote: entry.name,
          env,
          remediation: "Re-run with --force only after verifying the remote target.",
        }),
      );
    }
    const plan = yield* resolvePlan(options.cwd, target);
    const artifacts: DataEndpoint[] = [];
    yield* confirmDestructive(`Push ${kinds.join(", ")} to ${entry.name}@${env}?`, options);
    for (const kind of kinds) {
      if (dataset.value.kind !== kind) {
        return yield* Effect.fail(
          new RemoteDatasetUnsupportedError({
            message: "No Dataset is installed for the requested kind.",
            dataset: kind,
          }),
        );
      }
      const ctx = datasetContext(plan, kind, loaded.landofile);
      const artifact = yield* Effect.scoped(dataset.value.capture(ctx));
      artifacts.push(artifact);
      const locator = yield* source.resolve(entry.config, env, kind);
      yield* Effect.scoped(
        source.send(locator, artifact, {
          force: options.force,
          protectedEnvConfirmed: options.force === true,
        }),
      );
    }
    return {
      direction: "push",
      remote: entry.name,
      env,
      datasets: kinds,
      changed: artifacts.length > 0,
      artifacts,
    };
  });

export const renderRemoteListResult = (
  result: ReadonlyArray<RemoteEntry>,
  format: "text" | "json" = "text",
): string => {
  if (format === "json") return JSON.stringify(result, null, 2);
  if (result.length === 0) return "No remotes configured.";
  return result.map((entry) => `${entry.name}\t${entry.config.source}`).join("\n");
};

export const renderRemoteMutationResult = (
  result: RemoteMutationResult,
  action: "added" | "removed",
  format: "text" | "json" = "text",
): string => {
  if (format === "json") return JSON.stringify(result, null, 2);
  return `${action}: ${result.remote}`;
};

export const renderRemoteTestResult = (
  result: RemoteTestResult,
  format: "text" | "json" = "text",
): string => {
  if (format === "json") return JSON.stringify(result, null, 2);
  return `${result.ok ? "ok" : "failed"}${result.env === undefined ? "" : `: ${result.env}`}${result.message === undefined ? "" : ` - ${result.message}`}`;
};

export const renderRemoteEnvListResult = (
  result: ReadonlyArray<RemoteEnvironmentType>,
  format: "text" | "json" = "text",
): string => {
  if (format === "json") return JSON.stringify(result, null, 2);
  if (result.length === 0) return "No remote environments.";
  return result.map((entry) => `${entry.id}${entry.default === true ? "\t(default)" : ""}`).join("\n");
};

export const renderSyncResult = (result: SyncResultType, format: "text" | "json" = "text"): string => {
  if (format === "json") return JSON.stringify(result, null, 2);
  return `${result.direction}: ${result.remote}@${result.env} (${result.datasets.join(", ")})${result.changed ? " changed" : " unchanged"}`;
};

export { SyncResult };
