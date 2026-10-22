import type { LandofileLayer } from "@lando/sdk/schema";
import { ConfigService, Logger, ManagedFileTransactionGuard } from "@lando/sdk/services";
import { type Context, Effect } from "effect";
import { DEFAULT_LANDOFILE_LOAD_POLICY, type LandofileLoadPolicy } from "./load-expression-file.ts";
import type { LandofileRuntimeInputs } from "./ports.ts";

export interface LandofileLoadContext {
  readonly validCanonicalFile?: string;
  readonly appRoot: string;
  readonly layer: LandofileLayer;
  readonly policy: LandofileLoadPolicy;
  readonly logger?: Context.Service.Shape<typeof Logger> | undefined;
}

export const ensureConsistentRoot = Effect.fnUntraced(function* (
  appRoot: string,
  inputs?: Pick<LandofileRuntimeInputs, "transactionGuard">,
) {
  const option =
    inputs?.transactionGuard === undefined
      ? yield* Effect.serviceOption(ManagedFileTransactionGuard)
      : undefined;
  const guard = inputs?.transactionGuard ?? (option?._tag === "Some" ? option.value : undefined);
  if (guard !== undefined) yield* guard.ensureConsistent(appRoot);
});

export const loadContext = Effect.fnUntraced(function* (
  appRoot: string,
): Effect.fn.Return<Omit<LandofileLoadContext, "layer">> {
  const config = yield* Effect.serviceOption(ConfigService);
  const logger = yield* Effect.serviceOption(Logger);
  const policy =
    config._tag === "None"
      ? DEFAULT_LANDOFILE_LOAD_POLICY
      : yield* config.value.load.pipe(
          Effect.map((value) => ({
            allowOutsideRoot: value.allowLoadOutsideRoot,
            maxFileBytes: value.loadMaxFileBytes,
            maxFilesPerExpression: value.loadMaxFilesPerExpression,
            maxRecursionDepth: value.loadMaxRecursionDepth,
          })),
        );
  return { appRoot, policy, ...(logger._tag === "Some" ? { logger: logger.value } : {}) };
});
