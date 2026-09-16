import { Effect, Schema } from "effect";

import { NotImplementedError } from "@lando/sdk/errors";
import { validatePluginManifest } from "../operations/plugin-install.ts";
import { inspectInstalledPluginRegistry } from "../plugins/installed-registry.ts";
import { withPluginMutationLock } from "../plugins/mutation-lock.ts";
import { UpdatePermissionError } from "./errors.ts";
import { planUpdates } from "./plugin-plan.ts";

export const CoreReplacementPreconditionSchema = Schema.Struct({
  pluginsRoot: Schema.String,
  currentCoreVersion: Schema.String,
  targetCoreVersion: Schema.String,
});
export type CoreReplacementPrecondition = typeof CoreReplacementPreconditionSchema.Type;

const compatibilityFailure = () =>
  new UpdatePermissionError({
    message: "Core replacement aborted: the active plugin set changed or cannot be verified as compatible.",
    remediation:
      "The plugin set changed. Resolve plugin compatibility, then re-run lando update; completed plugin updates remain active.",
  });

export const checkCoreReplacement = (input: CoreReplacementPrecondition) =>
  Effect.gen(function* () {
    const inspection = yield* Effect.tryPromise({
      try: () => inspectInstalledPluginRegistry(input.pluginsRoot),
      catch: compatibilityFailure,
    });
    if (inspection.failures.length > 0) return yield* Effect.fail(compatibilityFailure());
    const plugins = yield* Effect.forEach(Object.values(inspection.registry), (entry) =>
      Effect.tryPromise({
        try: () => validatePluginManifest(entry.path),
        catch: compatibilityFailure,
      }).pipe(
        Effect.map(({ manifest }) => ({
          name: entry.name,
          currentVersion: entry.version,
          requestedSelector: entry.version,
          ...(manifest.requires === undefined ? {} : { currentRequires: manifest.requires }),
          ...(manifest.bundled === undefined ? {} : { bundled: manifest.bundled }),
          trusted: true,
        })),
      ),
    );
    const plan = planUpdates({ ...input, selection: "all", plugins });
    if (plan.rows.some((row) => row.kind === "core" && row.status === "blocked"))
      return yield* Effect.fail(compatibilityFailure());
  });

export const guardCoreReplacement = <A, E, R>(
  input: CoreReplacementPrecondition,
  body: Effect.Effect<A, E, R>,
) =>
  withPluginMutationLock(
    input.pluginsRoot,
    "meta:update",
    checkCoreReplacement(input).pipe(Effect.zipRight(body)),
  ).pipe(
    Effect.mapError((error) =>
      error instanceof NotImplementedError
        ? new UpdatePermissionError({ message: error.message, remediation: error.remediation })
        : error,
    ),
  );
