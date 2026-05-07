/**
 * `lando list` — list services across apps.
 *
 * Works inside and outside app context, supports `--all`, filters, `--path`,
 * JSON, table. Bootstrap level: `provider`.
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
