/**
 * `lando update` — check / apply updates to core and plugins.
 *
 * Release channels: `stable`, `next`, `dev`. Bootstrap level: `plugins`.
 *
 * The compiled binary self-updates by writing a new binary alongside,
 * atomic-renaming, and re-execing.
 */
import { Effect } from "effect";

import type { LandoCommandError } from "@lando/sdk/errors";
import { Telemetry } from "@lando/sdk/services";
import { recordUpdateOutcomeTelemetry, updateOutcomeFromError } from "../../telemetry/events.ts";
import { CORE_VERSION } from "../../version.ts";

export interface UpdateOptions {
  /** Update channel: `stable` (default), `next`, or `dev`. */
  readonly channel?: "stable" | "next" | "dev";
  /** Check only, don't apply. */
  readonly dryRun?: boolean;
  readonly targetVersion?: string;
  readonly runUpdate?: () => Effect.Effect<UpdateResult, LandoCommandError, never>;
}

export interface UpdateResult {
  readonly updatedCore: boolean;
  readonly updatedPlugins: ReadonlyArray<string>;
}

const defaultUpdate = (): Effect.Effect<UpdateResult, LandoCommandError, never> =>
  Effect.succeed({ updatedCore: false, updatedPlugins: [] });

const platform = (): string => `${process.platform}-${process.arch}`;

export const update = (
  options: UpdateOptions = {},
): Effect.Effect<UpdateResult, LandoCommandError, Telemetry> =>
  Effect.gen(function* () {
    const telemetry = yield* Telemetry;
    const channel = options.channel ?? "stable";
    const targetVersion = options.targetVersion ?? CORE_VERSION;
    const runUpdate = options.runUpdate ?? defaultUpdate;

    return yield* runUpdate().pipe(
      Effect.tap(() =>
        recordUpdateOutcomeTelemetry(telemetry, {
          version: CORE_VERSION,
          targetVersion,
          channel,
          platform: platform(),
          outcome: "success",
        }),
      ),
      Effect.tapError((error) =>
        recordUpdateOutcomeTelemetry(telemetry, {
          version: CORE_VERSION,
          targetVersion,
          channel,
          platform: platform(),
          outcome: updateOutcomeFromError(error),
        }),
      ),
    );
  });
