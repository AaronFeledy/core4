import { Effect, Schema } from "effect";

import type { GlobalAppError, LandofileParseError, LandofileValidationError } from "@lando/sdk/errors";
import { LandofileShape, type LandofileShape as LandofileShapeType } from "@lando/sdk/schema";
import { FileSystem, type FileSystemError, type GlobalAppPaths, GlobalAppService } from "@lando/sdk/services";

import { decodeGlobalLandofile } from "./global-plan.ts";

export interface GlobalConfigResult {
  readonly app: string;
  readonly source: "global";
  readonly materialized: boolean;
  readonly distLandofile: string;
  readonly userLandofile: string;
  readonly paths: GlobalAppPaths;
  readonly landofile: LandofileShapeType;
}

export const GlobalAppPathsSchema = Schema.Struct({
  root: Schema.String,
  distLandofile: Schema.String,
  userLandofile: Schema.String,
});

export const GlobalConfigResultSchema = Schema.Struct({
  app: Schema.String,
  source: Schema.Literal("global"),
  materialized: Schema.Boolean,
  distLandofile: Schema.String,
  userLandofile: Schema.String,
  paths: GlobalAppPathsSchema,
  landofile: LandofileShape,
});

type GlobalConfigError = GlobalAppError | FileSystemError | LandofileParseError | LandofileValidationError;

type GlobalConfigServices = FileSystem | GlobalAppService;

const emptyGlobalLandofile: LandofileShapeType = { name: "global", runtime: 4, services: {} };

export const renderGlobalConfigResult = (
  result: GlobalConfigResult,
  _format: "json" | "table" = "table",
): string => {
  void _format;
  const services = Object.keys(result.landofile.services ?? {});
  return [
    `app\t${result.app}`,
    `source\t${result.materialized ? "generated" : "not installed"}`,
    `dist\t${result.distLandofile}`,
    `overlay\t${result.userLandofile}`,
    `services\t${services.length === 0 ? "(none)" : services.join(", ")}`,
  ].join("\n");
};

export const globalConfig = (): Effect.Effect<GlobalConfigResult, GlobalConfigError, GlobalConfigServices> =>
  Effect.gen(function* () {
    const globalApp = yield* GlobalAppService;
    const fileSystem = yield* FileSystem;
    const paths = yield* globalApp.paths;
    const exists = yield* fileSystem.exists(paths.distLandofile);
    const landofile = exists
      ? yield* fileSystem
          .readText(paths.distLandofile)
          .pipe(
            Effect.flatMap((content) =>
              decodeGlobalLandofile({ file: paths.distLandofile, content, cwd: paths.root }),
            ),
          )
      : emptyGlobalLandofile;

    return {
      app: landofile.name ?? "global",
      source: "global",
      materialized: exists,
      distLandofile: paths.distLandofile,
      userLandofile: paths.userLandofile,
      paths,
      landofile,
    };
  });
