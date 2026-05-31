import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";

import { type Context, Effect, Layer } from "effect";

import { ScratchAppError, ScratchAppNotFoundError, ScratchSourceUnresolvedError } from "@lando/sdk/errors";
import { AbsolutePath } from "@lando/sdk/schema";
import {
  AppPlanner,
  FileSystem,
  LandofileService,
  RuntimeProviderRegistry,
  type ScratchAcquireInput,
  ScratchAppService,
  type ScratchHandle,
} from "@lando/sdk/services";

import { resolveUserCacheRoot } from "../cache/paths.ts";

export { ScratchAppService } from "@lando/sdk/services";

export const SCRATCH_DIR = "scratch";

const scratchAppError = (operation: string, message: string, cause: unknown): ScratchAppError =>
  new ScratchAppError({ message, operation, cause });

const scratchSourceLabel = (input: ScratchAcquireInput): string => {
  if (input.source === undefined) return "unresolved";
  if (input.source.kind === "fork") return "fork";
  return `recipe:${input.source.ref}`;
};

const scratchSourceUnresolvedError = (input: ScratchAcquireInput): ScratchSourceUnresolvedError =>
  new ScratchSourceUnresolvedError({
    message: `Unable to resolve scratch source ${scratchSourceLabel(input)}.`,
    source: scratchSourceLabel(input),
    attempts: [],
    remediation:
      "Scratch source resolution is not available in this build yet, so no scratch app was created.",
  });

const scratchForkUnresolvedError = (): ScratchSourceUnresolvedError =>
  new ScratchSourceUnresolvedError({
    message: "Unable to resolve scratch source fork.",
    source: "fork",
    attempts: [],
    remediation: "Run `lando apps:scratch:start --fork` from a directory containing a Landofile.",
  });

const scratchAppNotFoundError = (id: string): ScratchAppNotFoundError =>
  new ScratchAppNotFoundError({
    message: `Scratch app ${id} was not found.`,
    id,
    suggestions: [],
    remediation: "Run `lando apps:scratch:list` to see currently registered scratch apps.",
  });

const sanitizeBase = (base: string): string => {
  const cleaned = base
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return cleaned.length === 0 ? "scratch" : cleaned;
};

// Security: reject ids that `join` could use to escape `<userCacheRoot>/scratch/<id>/`
// — path separators, NUL, or a pure-dot segment (`.`, `..`).
const isUnsafeScratchId = (id: string): boolean =>
  id.length === 0 || /[/\\\0]/u.test(id) || /^\.+$/u.test(id);

const makeScratchAppService = (
  fileSystem: Context.Tag.Service<typeof FileSystem>,
  landofileService: Context.Tag.Service<typeof LandofileService>,
  planner: Context.Tag.Service<typeof AppPlanner>,
  registry: Context.Tag.Service<typeof RuntimeProviderRegistry>,
): Context.Tag.Service<typeof ScratchAppService> => {
  const root = Effect.sync(() => AbsolutePath.make(join(resolveUserCacheRoot(), SCRATCH_DIR)));

  const ensureRoot = root.pipe(
    Effect.flatMap((path) =>
      fileSystem.mkdir(path).pipe(
        Effect.as(path),
        Effect.mapError((cause) =>
          scratchAppError("ensureRoot", `Unable to create the scratch app directory at ${path}.`, cause),
        ),
      ),
    ),
  );

  const synthesizeId = (base: string) =>
    Effect.sync(() => {
      const suffix = createHash("sha256")
        .update(`${base}:${Date.now()}:${process.pid}:${randomBytes(8).toString("hex")}`)
        .digest("hex")
        .slice(0, 6);
      return `scratch-${sanitizeBase(base)}-${suffix}`;
    });

  const paths = (id: string) =>
    isUnsafeScratchId(id)
      ? Effect.fail(
          scratchAppError("paths", `Refusing to resolve scratch paths for unsafe id "${id}".`, undefined),
        )
      : root.pipe(
          Effect.map((base) => {
            const instanceRoot = AbsolutePath.make(join(base, id));
            return {
              base,
              instanceRoot,
              root: AbsolutePath.make(join(instanceRoot, "root")),
              planCache: AbsolutePath.make(join(instanceRoot, "plan.bin")),
              infoCache: AbsolutePath.make(join(instanceRoot, "info.json")),
              buildResults: AbsolutePath.make(join(instanceRoot, "build-results.bin")),
            };
          }),
        );

  const materializeDir = (path: AbsolutePath) =>
    fileSystem
      .mkdir(path)
      .pipe(
        Effect.mapError((cause) =>
          scratchAppError("materialize", `Unable to create the scratch app directory at ${path}.`, cause),
        ),
      );

  const acquire = (input: ScratchAcquireInput) => {
    if (input.source.kind !== "fork") return Effect.fail(scratchSourceUnresolvedError(input));

    return Effect.gen(function* () {
      const landofile = yield* landofileService.discover.pipe(
        Effect.mapError(() => scratchForkUnresolvedError()),
      );
      const capabilities = yield* registry.capabilities.pipe(
        Effect.mapError((cause) =>
          scratchAppError("acquire", "Unable to resolve provider capabilities for the scratch app.", cause),
        ),
      );
      const sourcePlan = yield* planner
        .plan(landofile, capabilities)
        .pipe(
          Effect.mapError((cause) =>
            scratchAppError("acquire", "Unable to plan the source app for the scratch fork.", cause),
          ),
        );
      const base = input.name ?? landofile.name ?? sourcePlan.name;
      const scratchId = yield* synthesizeId(base);
      const scratchPaths = yield* paths(scratchId);

      yield* materializeDir(scratchPaths.instanceRoot);
      yield* materializeDir(scratchPaths.root);

      const forkLandofile = { ...landofile, name: scratchId };
      const forkPlan = yield* planner
        .plan(forkLandofile, capabilities)
        .pipe(
          Effect.mapError((cause) =>
            scratchAppError("start", `Unable to plan scratch app ${scratchId}.`, cause),
          ),
        );
      const provider = yield* registry
        .select(forkPlan)
        .pipe(
          Effect.mapError((cause) =>
            scratchAppError("start", `Unable to select a provider for scratch app ${scratchId}.`, cause),
          ),
        );

      yield* Effect.scoped(provider.apply(forkPlan, { reconcile: false })).pipe(
        Effect.mapError((cause) =>
          scratchAppError("start", `Unable to start scratch app ${scratchId}.`, cause),
        ),
      );

      return {
        id: scratchId,
        app: { kind: "scratch", id: scratchId, root: forkPlan.root },
      } satisfies ScratchHandle;
    });
  };
  const resolveById = (id: string) => Effect.fail(scratchAppNotFoundError(id));
  const list = () => Effect.succeed([]);
  const start = (id: string) => resolveById(id);
  const stop = (id: string) => resolveById(id);
  const destroy = (id: string) => resolveById(id);
  const gc = () => Effect.succeed({ inspected: 0, reaped: [], errors: [] });

  return {
    kind: "scratch",
    root,
    ensureRoot,
    synthesizeId,
    paths,
    acquire,
    resolveById,
    list,
    start,
    stop,
    destroy,
    gc,
  };
};

export const ScratchAppServiceLive = Layer.effect(
  ScratchAppService,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem;
    const landofileService = yield* LandofileService;
    const planner = yield* AppPlanner;
    const registry = yield* RuntimeProviderRegistry;
    return makeScratchAppService(fileSystem, landofileService, planner, registry);
  }),
);
