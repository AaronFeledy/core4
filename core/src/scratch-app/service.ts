import { createHash, randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { type Context, Effect, Either, Layer, Schema } from "effect";

import { ScratchAppError, ScratchAppNotFoundError, ScratchSourceUnresolvedError } from "@lando/sdk/errors";
import { AbsolutePath, type AppPlan, LandofileShape } from "@lando/sdk/schema";
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
import { initApp } from "../cli/commands/init.ts";
import { parseLandofile } from "../landofile/parser.ts";

const RECIPE_RESOLUTION_ERROR_TAGS = new Set([
  "RecipeManifestNotFoundError",
  "RecipeManifestParseError",
  "RecipeManifestValidationError",
  "NotImplementedError",
]);

const RECIPE_PROMPT_ERROR_TAGS = new Set(["RecipeMissingAnswerError", "RecipePromptValidationError"]);

export { ScratchAppService } from "@lando/sdk/services";

export const SCRATCH_DIR = "scratch";

const scratchAppError = (
  operation: string,
  message: string,
  cause: unknown,
  remediation?: string,
): ScratchAppError =>
  new ScratchAppError({ message, operation, cause, ...(remediation === undefined ? {} : { remediation }) });

const scratchSourceLabel = (input: ScratchAcquireInput): string => {
  if (input.source === undefined) return "unresolved";
  if (input.source.kind === "fork") return "fork";
  return `recipe:${input.source.ref}`;
};

const scratchSourceRemediation = (input: ScratchAcquireInput): string =>
  input.source?.kind === "recipe"
    ? "Verify the recipe reference and try again, e.g. `lando apps:scratch:start --from empty`."
    : "Scratch source resolution is not available in this build yet, so no scratch app was created.";

const scratchSourceUnresolvedError = (input: ScratchAcquireInput): ScratchSourceUnresolvedError =>
  new ScratchSourceUnresolvedError({
    message: `Unable to resolve scratch source ${scratchSourceLabel(input)}.`,
    source: scratchSourceLabel(input),
    attempts: [],
    remediation: scratchSourceRemediation(input),
  });

const scratchForkUnresolvedError = (): ScratchSourceUnresolvedError =>
  new ScratchSourceUnresolvedError({
    message: "Unable to resolve scratch source fork.",
    source: "fork",
    attempts: [],
    remediation: "Run `lando apps:scratch:start --fork` from a directory containing a Landofile.",
  });

const withProcessCwd = <A, E, R>(
  dir: string,
  use: () => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ScratchAppError, R> =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        const original = process.cwd();
        process.chdir(dir);
        return original;
      },
      catch: (cause) =>
        scratchAppError("plan", `Unable to enter the scratch app directory at ${dir}.`, cause),
    }),
    () => use(),
    (original) => Effect.sync(() => process.chdir(original)),
  );

const causeRecord = (cause: unknown): Record<string, unknown> | undefined =>
  typeof cause === "object" && cause !== null ? (cause as Record<string, unknown>) : undefined;

const causeTag = (cause: unknown): string | undefined => {
  const record = causeRecord(cause);
  return record !== undefined && "_tag" in record ? String(record._tag) : undefined;
};

const promptInitError = (input: ScratchAcquireInput, cause: unknown): ScratchAppError => {
  const record = causeRecord(cause);
  const promptName = typeof record?.promptName === "string" ? record.promptName : undefined;
  const causeMessage = typeof record?.message === "string" ? record.message : "Recipe prompt failed.";
  const promptLabel = promptName === undefined ? "recipe prompt" : `recipe prompt "${promptName}"`;
  const remediation =
    promptName === undefined
      ? "Provide required recipe prompt values with --answer key=value or --option key=value."
      : `Provide it with --answer ${promptName}=<value> or --option ${promptName}=<value>.`;
  return scratchAppError(
    "materialize",
    `Unable to answer ${promptLabel} for scratch source ${scratchSourceLabel(input)}: ${causeMessage}`,
    cause,
    remediation,
  );
};

const mapInitError = (
  input: ScratchAcquireInput,
  cause: unknown,
): ScratchSourceUnresolvedError | ScratchAppError => {
  const tag = causeTag(cause);
  if (tag !== undefined && RECIPE_RESOLUTION_ERROR_TAGS.has(tag)) {
    return scratchSourceUnresolvedError(input);
  }
  if (tag !== undefined && RECIPE_PROMPT_ERROR_TAGS.has(tag)) {
    return promptInitError(input, cause);
  }
  return scratchAppError("materialize", "Unable to render the recipe into the scratch app root.", cause);
};

const decodeScratchLandofile = (
  file: string,
  content: string,
  cwd: string,
): Effect.Effect<LandofileShape, ScratchAppError> =>
  parseLandofile({ file, content, cwd }).pipe(
    Effect.mapError((cause) =>
      scratchAppError("materialize", `Unable to parse the rendered scratch Landofile at ${file}.`, cause),
    ),
    Effect.flatMap((parsed) => {
      const decoded = Schema.decodeUnknownEither(LandofileShape)(parsed, { onExcessProperty: "error" });
      return Either.isRight(decoded)
        ? Effect.succeed(decoded.right)
        : Effect.fail(
            scratchAppError(
              "materialize",
              `The rendered scratch Landofile at ${file} is invalid.`,
              decoded.left,
            ),
          );
    }),
  );

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

  const cleanupScratchInstance = (path: AbsolutePath) =>
    Effect.tryPromise({
      try: () => rm(path, { recursive: true, force: true }),
      catch: (cause) =>
        scratchAppError("cleanup", `Unable to remove the failed scratch app directory at ${path}.`, cause),
    });

  const startScratchPlan = (scratchId: string, plan: AppPlan) =>
    Effect.gen(function* () {
      const provider = yield* registry
        .select(plan)
        .pipe(
          Effect.mapError((cause) =>
            scratchAppError("start", `Unable to select a provider for scratch app ${scratchId}.`, cause),
          ),
        );
      yield* Effect.scoped(provider.apply(plan, { reconcile: false })).pipe(
        Effect.mapError((cause) =>
          scratchAppError("start", `Unable to start scratch app ${scratchId}.`, cause),
        ),
      );
      return {
        id: scratchId,
        app: { kind: "scratch", id: scratchId, root: plan.root },
      } satisfies ScratchHandle;
    });

  const acquireFork = (input: ScratchAcquireInput) =>
    Effect.gen(function* () {
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
      return yield* startScratchPlan(scratchId, forkPlan);
    });

  const acquireRecipe = (input: ScratchAcquireInput, recipeRef: string) =>
    Effect.gen(function* () {
      const ref = recipeRef.trim();
      if (ref.length === 0) return yield* Effect.fail(scratchSourceUnresolvedError(input));

      const base = input.name ?? ref;
      const scratchId = yield* synthesizeId(base);
      const scratchPaths = yield* paths(scratchId);

      yield* materializeDir(scratchPaths.instanceRoot);
      yield* materializeDir(scratchPaths.root);

      yield* Effect.tryPromise({
        try: () =>
          initApp({
            cwd: scratchPaths.instanceRoot,
            destination: scratchPaths.root,
            full: false,
            recipe: ref,
            name: scratchId,
            runPostInit: false,
            ...(input.answers === undefined ? {} : { answers: input.answers }),
            ...(input.yes === undefined ? {} : { yes: input.yes }),
            ...(input.nonInteractive === undefined ? {} : { nonInteractive: input.nonInteractive }),
          }),
        catch: (cause) => mapInitError(input, cause),
      }).pipe(Effect.tapError(() => Effect.ignore(cleanupScratchInstance(scratchPaths.instanceRoot))));

      const landofilePath = join(scratchPaths.root, ".lando.yml");
      const content = yield* fileSystem
        .readText(landofilePath)
        .pipe(
          Effect.mapError((cause) =>
            scratchAppError(
              "materialize",
              `Unable to read the rendered scratch Landofile at ${landofilePath}.`,
              cause,
            ),
          ),
        );
      const landofile = yield* decodeScratchLandofile(landofilePath, content, scratchPaths.root);
      const recipeLandofile = { ...landofile, name: scratchId };

      const capabilities = yield* registry.capabilities.pipe(
        Effect.mapError((cause) =>
          scratchAppError("acquire", "Unable to resolve provider capabilities for the scratch app.", cause),
        ),
      );
      const recipePlan = yield* withProcessCwd(scratchPaths.root, () =>
        planner.plan(recipeLandofile, capabilities),
      ).pipe(
        Effect.mapError((cause) =>
          scratchAppError("start", `Unable to plan scratch app ${scratchId}.`, cause),
        ),
      );
      return yield* startScratchPlan(scratchId, recipePlan);
    });

  const acquire = (input: ScratchAcquireInput) =>
    input.source.kind === "fork" ? acquireFork(input) : acquireRecipe(input, input.source.ref);
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
