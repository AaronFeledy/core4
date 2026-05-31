import { Effect } from "effect";

import type { GlobalAppError, LandofileParseError, LandofileValidationError } from "@lando/sdk/errors";
import type { LandofileShape } from "@lando/sdk/schema";
import { FileSystem, type FileSystemError, type GlobalAppPaths, GlobalAppService } from "@lando/sdk/services";

import { decodeGlobalLandofile } from "./global-plan.ts";

export interface GlobalConfigResult {
  readonly app: string;
  readonly source: "global";
  readonly materialized: boolean;
  readonly distLandofile: string;
  readonly userLandofile: string;
  readonly paths: GlobalAppPaths;
  readonly landofile: LandofileShape;
}

type GlobalConfigError = GlobalAppError | FileSystemError | LandofileParseError | LandofileValidationError;

type GlobalConfigServices = FileSystem | GlobalAppService;

const emptyGlobalLandofile: LandofileShape = { name: "global", runtime: 4, services: {} };

const jsonReplacer = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value;

export const renderGlobalConfigResult = (
  result: GlobalConfigResult,
  format: "json" | "table" = "table",
): string => {
  if (format === "json") return JSON.stringify(result.landofile, jsonReplacer, 2);
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
