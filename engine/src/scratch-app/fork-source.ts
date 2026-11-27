import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { LandofileLayersOmittedError } from "@lando/landofile/layers";
import { OperationDiscovery, withAppDiscovery } from "@lando/landofile/operation-discovery";
import { findDiscoveredLandofilePath } from "@lando/landofile/service";
import { causeRemediation, mapFailures } from "@lando/sdk/command-result";
import { LandofileNotFoundError, ScratchAppError, ScratchIsolationConflictError } from "@lando/sdk/errors";
import { FileSystem, PathsService, type ScratchAcquireInput } from "@lando/sdk/services";
import { Context, Effect, Layer, Ref, Result } from "effect";
import { canonicalAppRoot } from "../operations/app-root-identity.ts";
import { AppPluginRoot } from "../plugins/app-plugin-root.ts";

type ForkSource = Extract<ScratchAcquireInput["source"], { readonly kind: "fork" }>;

const forkSourceRemediation =
  "Pass `--source` a directory inside the Lando app to fork, or omit it to use the current app.";

export const scratchIsolationConflict = (input: Pick<ScratchAcquireInput, "mountCwd" | "isolate">) =>
  input.mountCwd !== undefined && input.isolate === "full"
    ? new ScratchIsolationConflictError({
        message: "--mount-cwd and --isolate=full cannot be combined.",
        flags: ["--mount-cwd", "--isolate=full"],
        remediation:
          "Pass --mount-cwd on its own to serve your current directory, or drop it to keep --isolate=full.",
      })
    : undefined;

const scratchForkDirectory = Effect.fnUntraced(function* (cwd: string, path: string) {
  if (path.trim().length === 0) {
    return yield* new ScratchAppError({
      operation: "acquire",
      message: "The scratch fork source path is empty.",
      remediation: forkSourceRemediation,
    });
  }
  const directory = resolve(cwd, path);
  const fileSystem = yield* FileSystem;
  const info = yield* fileSystem.stat(directory).pipe(
    mapFailures(
      (cause) =>
        new ScratchAppError({
          operation: "acquire",
          message: `Unable to access scratch fork source directory ${directory}: ${cause.message}`,
          cause,
          remediation: causeRemediation(cause) ?? forkSourceRemediation,
        }),
    ),
  );
  if (!info.isDirectory) {
    return yield* new ScratchAppError({
      operation: "acquire",
      message: `Scratch fork source ${directory} is not a directory.`,
      remediation: forkSourceRemediation,
    });
  }
  return directory;
});

export const scratchForkLoadFailure = (directory: string, cause: { readonly message: string }) =>
  new ScratchAppError({
    operation: "acquire",
    message: `Unable to load the scratch fork source from ${directory}: ${cause.message}`,
    cause,
    remediation:
      cause instanceof LandofileNotFoundError && !(cause instanceof LandofileLayersOmittedError)
        ? forkSourceRemediation
        : (causeRemediation(cause) ?? forkSourceRemediation),
  });

const sourceChanged = (directory: string, cause?: unknown) =>
  new ScratchAppError({
    operation: "acquire",
    message: `Scratch fork source ${directory} changed while selecting or acquiring the app.`,
    remediation: "Make sure the source directory and app root are stable, then retry the fork.",
    ...(cause === undefined ? {} : { cause }),
  });

const directoryIdentity = Effect.fnUntraced(function* (path: string) {
  const { canonical, info } = yield* Effect.tryPromise({
    try: async () => {
      const canonical = await realpath(path);
      return { canonical, info: await stat(canonical, { bigint: true }) };
    },
    catch: (cause) => sourceChanged(path, cause),
  });
  if (!info.isDirectory()) return yield* sourceChanged(path);
  return { canonical, id: `${info.dev}:${info.ino}` };
});

export type AdmittedFork = {
  readonly root: string;
  readonly discovery: typeof OperationDiscovery.Service;
  readonly verify: Effect.Effect<void, ScratchAppError>;
};

export class ScratchForkSource extends Context.Service<
  ScratchForkSource,
  {
    readonly cwd: string;
    readonly source: ForkSource;
    readonly admission: Effect.Effect<Result.Result<AdmittedFork, ScratchAppError>>;
  }
>()("@lando/engine/ScratchForkSource") {}

export const admitScratchFork = Effect.fnUntraced(function* (
  cwd: string,
  path: string,
  omitLocalOverrides: boolean,
) {
  const paths = yield* PathsService;
  const requested = yield* scratchForkDirectory(cwd, path);
  const directory = yield* directoryIdentity(requested);
  const canonicalOrMissing = (path: string) => canonicalAppRoot(path).pipe(Effect.orElseSucceed(() => path));
  const excludedRoots = yield* Effect.all({
    globalAppRoot: canonicalOrMissing(paths.globalAppRoot),
    scratchDir: canonicalOrMissing(paths.scratchDir),
  });
  const { discovery, appRoot } = yield* withAppDiscovery(
    directory.canonical,
    Effect.gen(function* () {
      const discovery = yield* OperationDiscovery;
      const { appRoot } = yield* findDiscoveredLandofilePath(undefined, { omitLocalOverrides }).pipe(
        mapFailures((cause) => scratchForkLoadFailure(requested, cause)),
      );
      return { discovery, appRoot };
    }),
  ).pipe(Effect.provideService(PathsService, { ...paths, ...excludedRoots }));
  const root = appRoot === directory.canonical ? directory : yield* directoryIdentity(appRoot);
  if (root.canonical !== appRoot) return yield* sourceChanged(requested);
  const verify = Effect.gen(function* () {
    const currentDirectory = yield* directoryIdentity(requested);
    const currentRoot =
      appRoot === currentDirectory.canonical ? currentDirectory : yield* directoryIdentity(appRoot);
    if (
      currentDirectory.canonical !== directory.canonical ||
      currentDirectory.id !== directory.id ||
      currentRoot.canonical !== root.canonical ||
      currentRoot.id !== root.id
    ) {
      return yield* sourceChanged(requested);
    }
  });
  return { root: appRoot, discovery, verify } satisfies AdmittedFork;
});

export const scratchForkSourceLayer = (
  cwd: string,
  source: ForkSource,
  omitLocalOverrides = false,
): Layer.Layer<never, never, FileSystem | PathsService> => {
  const { path } = source;
  if (path === undefined) return Layer.empty;
  return Layer.effectContext(
    Effect.gen(function* () {
      const admission = yield* Ref.make(
        yield* Effect.result(admitScratchFork(cwd, path, omitLocalOverrides)),
      );
      const current = Effect.gen(function* () {
        const admitted = yield* Ref.get(admission);
        if (Result.isFailure(admitted)) return undefined;
        return yield* admitted.success.verify.pipe(
          Effect.as(admitted.success.root),
          Effect.catch((cause) =>
            // Once drift is observed, acquisition must refuse it even if the path changes back.
            Ref.set(admission, Result.fail(cause)).pipe(Effect.as(undefined)),
          ),
        );
      });
      return Context.make(ScratchForkSource, { cwd, source, admission: Ref.get(admission) }).pipe(
        Context.add(AppPluginRoot, { current }),
      );
    }),
  );
};

export const checkAdmittedForkRoot = (admitted: AdmittedFork, root: string) =>
  admitted.root === root ? Effect.void : Effect.fail(sourceChanged(admitted.root));
