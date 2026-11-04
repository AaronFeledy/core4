import { isAbsolute, join } from "node:path";

import { type Context, Effect, Layer } from "effect";

import { GlobalAppError, GlobalLandofilePathConflictError } from "@lando/sdk/errors";
import { AbsolutePath, type ServiceConfig } from "@lando/sdk/schema";
import { ConfigService, FileSystem, GlobalAppService } from "@lando/sdk/services";
import { bindMountSources, readManagedGlobalDist, renderGlobalDist } from "./dist-content.ts";

export { GlobalAppService } from "@lando/sdk/services";
export { renderGlobalDist } from "./dist-content.ts";

export const GLOBAL_APP_ID = "global";

const userLandofileContent = [
  "# User overrides for the global Lando app.",
  "# Generated services live in .lando.dist.yml (merged before this file).",
  "",
].join("\n");

const globalAppError = (
  operation: string,
  message: string,
  cause: unknown,
  remediation: string,
): GlobalAppError => new GlobalAppError({ message, operation, cause, remediation });

export const makeGlobalAppService = (
  configService: Context.Service.Shape<typeof ConfigService>,
  fileSystem: Context.Service.Shape<typeof FileSystem>,
): Context.Service.Shape<typeof GlobalAppService> => {
  const root = configService.get("userDataRoot").pipe(
    Effect.flatMap((userDataRoot) =>
      userDataRoot === undefined
        ? Effect.fail(
            new GlobalAppError({
              message: "No user data root is configured; cannot locate the global app directory.",
              operation: "root",
              remediation: "Set userDataRoot in the Lando config or LANDO_USER_DATA_ROOT.",
            }),
          )
        : Effect.succeed(AbsolutePath.make(join(userDataRoot, GLOBAL_APP_ID))),
    ),
  );

  return makeGlobalAppServiceForRoot(root, fileSystem);
};

export const makeGlobalAppServiceForRoot = (
  root: Context.Service.Shape<typeof GlobalAppService>["root"],
  fileSystem: Context.Service.Shape<typeof FileSystem>,
): Context.Service.Shape<typeof GlobalAppService> => {
  // The canonical layer in effect: a `.lando.ts` the user wrote, else the YAML Lando seeds and writes.
  const paths = root.pipe(
    Effect.flatMap((globalRoot) => {
      const typescript = AbsolutePath.make(join(globalRoot, ".lando.ts"));
      return fileSystem.exists(typescript).pipe(
        Effect.mapError((cause) =>
          globalAppError(
            "paths",
            `Unable to inspect the global app TypeScript Landofile at ${typescript}.`,
            cause,
            `Ensure ${typescript} is accessible, then retry.`,
          ),
        ),
        Effect.map((hasTypescript) => ({
          root: globalRoot,
          distLandofile: AbsolutePath.make(join(globalRoot, ".lando.dist.yml")),
          userLandofile: hasTypescript ? typescript : AbsolutePath.make(join(globalRoot, ".lando.yml")),
        })),
      );
    }),
  );

  const ensureRoot = root.pipe(
    Effect.flatMap((path) =>
      fileSystem
        .mkdir(path)
        .pipe(
          Effect.mapError((cause) =>
            globalAppError(
              "ensureRoot",
              `Unable to create the global app directory at ${path}.`,
              cause,
              `Ensure ${path} is writable, or set LANDO_USER_DATA_ROOT to a writable directory.`,
            ),
          ),
        ),
    ),
  );

  const ensureUserLandofile = Effect.gen(function* () {
    const resolved = yield* paths;
    yield* ensureRoot;
    const existing = yield* fileSystem.lstat(resolved.userLandofile).pipe(
      Effect.map((stats) => ({ _tag: "stat" as const, stats })),
      Effect.catchTag("FileNotFoundError", () => Effect.succeed({ _tag: "missing" as const })),
      Effect.mapError((cause) =>
        globalAppError(
          "ensureUserLandofile",
          `Unable to inspect the global app overlay path at ${resolved.userLandofile}.`,
          cause,
          `Ensure ${resolved.userLandofile} is accessible, then retry \`lando global:reconcile\`.`,
        ),
      ),
    );

    if (existing._tag === "missing") {
      yield* fileSystem
        .writeAtomic(resolved.userLandofile, userLandofileContent)
        .pipe(
          Effect.mapError((cause) =>
            globalAppError(
              "ensureUserLandofile",
              `Unable to create the global app overlay file at ${resolved.userLandofile}.`,
              cause,
              `Ensure the parent of ${resolved.userLandofile} is writable, then retry \`lando global:reconcile\`.`,
            ),
          ),
        );
      return { path: resolved.userLandofile, created: true };
    }

    if (existing.stats.isDirectory) {
      return yield* Effect.fail(
        new GlobalLandofilePathConflictError({
          message: `The global app overlay path is a directory: ${resolved.userLandofile}.`,
          path: resolved.userLandofile,
          expected: "file",
          actual: "directory",
          remediation: `Remove the directory at ${resolved.userLandofile} so Lando can create the global overlay file.`,
        }),
      );
    }

    return { path: resolved.userLandofile, created: false };
  });

  const regenerateDist = Effect.fn("GlobalAppService.regenerateDist")(function* (input?: {
    readonly services?: Record<string, ServiceConfig>;
    readonly content?: string;
  }) {
    const resolved = yield* paths;
    const services = input?.services ?? {};
    const rendered = renderGlobalDist(services);
    if (input?.content !== undefined && input.content !== rendered)
      return yield* Effect.fail(
        globalAppError(
          "regenerateDist",
          "Prepared global configuration does not match its service map.",
          undefined,
          "Prepare the global configuration again before retrying publication.",
        ),
      );
    const prepareDirectories = Effect.gen(function* () {
      yield* ensureRoot;
      for (const source of bindMountSources(services)) {
        if (source === "~" || source.startsWith("~/")) continue;
        const mountPath = isAbsolute(source) ? source : join(resolved.root, source);
        yield* fileSystem
          .mkdir(mountPath)
          .pipe(
            Effect.mapError((cause) =>
              globalAppError(
                "regenerateDist",
                `Unable to create the global service bind-mount source at ${mountPath}.`,
                cause,
                `Ensure ${mountPath} is writable under the global app root, then retry.`,
              ),
            ),
          );
      }
    });
    const serviceIds = Object.keys(services).sort((left, right) => left.localeCompare(right));
    const nextContent = input?.content ?? rendered;
    const exists = yield* fileSystem
      .exists(resolved.distLandofile)
      .pipe(
        Effect.mapError((cause) =>
          globalAppError(
            "regenerateDist",
            `Unable to check the generated global app Landofile at ${resolved.distLandofile}.`,
            cause,
            `Ensure ${resolved.distLandofile} is accessible, then retry \`lando global:reconcile\`.`,
          ),
        ),
      );

    if (!exists) {
      yield* prepareDirectories;
      yield* fileSystem
        .writeAtomic(resolved.distLandofile, nextContent)
        .pipe(
          Effect.mapError((cause) =>
            globalAppError(
              "regenerateDist",
              `Unable to write the generated global app Landofile at ${resolved.distLandofile}.`,
              cause,
              `Ensure ${resolved.distLandofile} is writable, then retry \`lando global:reconcile\`.`,
            ),
          ),
        );
      return { path: resolved.distLandofile, status: "created" as const, serviceIds };
    }

    const currentContent = yield* readManagedGlobalDist(fileSystem, resolved.distLandofile);

    yield* prepareDirectories;
    if (currentContent === nextContent) {
      return { path: resolved.distLandofile, status: "unchanged" as const, serviceIds };
    }

    yield* fileSystem
      .writeAtomic(resolved.distLandofile, nextContent)
      .pipe(
        Effect.mapError((cause) =>
          globalAppError(
            "regenerateDist",
            `Unable to write the generated global app Landofile at ${resolved.distLandofile}.`,
            cause,
            `Ensure ${resolved.distLandofile} is writable, then retry \`lando global:reconcile\`.`,
          ),
        ),
      );
    return { path: resolved.distLandofile, status: "updated" as const, serviceIds };
  });

  const ensureRunning = () =>
    Effect.fail(
      globalAppError(
        "ensureRunning",
        "Global service startup requires the app runtime.",
        undefined,
        "Provide the app runtime layer that implements GlobalAppService.ensureRunning.",
      ),
    );
  return GlobalAppService.of({
    id: GLOBAL_APP_ID,
    providerId: Effect.fail(
      globalAppError(
        "providerId",
        "Global provider resolution requires the app runtime.",
        undefined,
        "Provide the app runtime layer that implements GlobalAppService.providerId.",
      ),
    ),
    root,
    ensureRoot,
    paths,
    ensureUserLandofile,
    ensureRunning,
    regenerateDist,
  });
};

export const layer = Layer.effect(
  GlobalAppService,
  Effect.gen(function* () {
    const configService = yield* ConfigService;
    const fileSystem = yield* FileSystem;
    return makeGlobalAppService(configService, fileSystem);
  }),
);
