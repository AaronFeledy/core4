/**
 * `lando apps:list` — list apps known to Lando.
 *
 * Walks the configured app-discovery roots, parses each discovered
 * Landofile metadata header, and returns the list. Works inside and
 * outside an app context. Supports `--all`, filters, `--path`, `--format
 * json|table`. Bootstrap level: `minimal` — discovery does not require
 * provider initialization.
 */
import type { Effect } from "effect";

import type { LandoCommandError } from "@lando/sdk/errors";
import type { ServiceInfo } from "@lando/sdk/schema";

export interface ListServicesOptions {
  readonly all?: boolean;
  readonly path?: string;
  readonly filters?: ReadonlyArray<string>;
}

export interface ListServicesResult {
  readonly services: ReadonlyArray<ServiceInfo>;
}

export const listServices = (
  _options?: ListServicesOptions,
): Effect.Effect<ListServicesResult, LandoCommandError, never> => {
  throw new Error("listServices: not yet implemented");
};
