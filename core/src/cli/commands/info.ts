/**
 * `lando info` — provider-neutral runtime info.
 *
 * Supports `--deep`, repeated `--filter`, `--path`, `--service`,
 * `--format json|table|yaml`.
 *
 * Bootstrap level: `app`.
 */
import type { Effect } from "effect";

import type { LandoCommandError } from "@lando/sdk/errors";
import type { ServiceInfo } from "@lando/sdk/schema";

export interface InfoAppOptions {
  readonly deep?: boolean;
  readonly service?: string;
  readonly path?: string;
  readonly filters?: ReadonlyArray<string>;
}

export interface InfoAppResult {
  readonly app: string;
  readonly services: ReadonlyArray<ServiceInfo>;
}

export const infoApp = (
  _options?: InfoAppOptions,
): Effect.Effect<InfoAppResult, LandoCommandError, never> => {
  throw new Error("infoApp: not yet implemented");
};
