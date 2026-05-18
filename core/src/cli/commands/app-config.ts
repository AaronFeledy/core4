import { Effect } from "effect";

import type {
  LandofileNotFoundError,
  LandofileParseError,
  LandofileValidationError,
  NotImplementedError,
} from "@lando/sdk/errors";
import type { LandofileShape } from "@lando/sdk/schema";
import { LandofileService } from "@lando/sdk/services";

export interface AppConfigOptions {
  readonly format?: "json" | "table";
  readonly path?: string;
}

export interface AppConfigResult {
  readonly app: string;
  readonly source: "resolved";
  readonly landofile: LandofileShape;
}

type AppConfigError =
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileValidationError
  | NotImplementedError;

type AppConfigServices = LandofileService;

const tableRender = (result: AppConfigResult): string => {
  const lines: string[] = [`app\t${result.app}`];
  const services = Object.keys(result.landofile.services ?? {});
  if (services.length === 0) lines.push("services\t(none)");
  else lines.push(`services\t${services.join(", ")}`);
  if (result.landofile.recipe !== undefined) lines.push(`recipe\t${result.landofile.recipe}`);
  return lines.join("\n");
};

const jsonReplacer = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value;

export const renderAppConfigResult = (
  result: AppConfigResult,
  format: "json" | "table" = "table",
): string => {
  if (format === "json") return JSON.stringify(result.landofile, jsonReplacer, 2);
  return tableRender(result);
};

export const appConfig = (
  _options: AppConfigOptions = {},
): Effect.Effect<AppConfigResult, AppConfigError, AppConfigServices> =>
  Effect.gen(function* () {
    const landofileService = yield* LandofileService;
    const landofile = yield* landofileService.discover;
    return {
      app: landofile.name ?? "",
      source: "resolved",
      landofile,
    };
  });
