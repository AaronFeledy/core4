import type { CompilationContext, LandofileLayer, ParsedPendingSite } from "@lando/sdk/schema";
import { ConfigService, Logger, ManagedFileTransactionGuard } from "@lando/sdk/services";
import { type Context, Effect } from "effect";
import { captureCompilationContext } from "./compilation.ts";
import { type EnvironmentRecorder, recordEnvironment } from "./environment-dependencies.ts";
import { DEFAULT_LANDOFILE_LOAD_POLICY, type LandofileLoadPolicy } from "./load-expression-file.ts";
import { type LoadFailureRecorder, createLoadFailureRecorder } from "./load-failures.ts";
import type { LandofileRuntimeInputs } from "./ports.ts";
import { hostExpressionEnvironment } from "./recipe-expressions.ts";

export interface LandofileLoadContext {
  readonly recorder?: LoadFailureRecorder;
  readonly validCanonicalFile?: string;
  readonly contained?: boolean;
  readonly pendingSites?: ParsedPendingSite[];
  readonly compilationContext?: CompilationContext;
  /**
   * Shared environment dependency recorder for this load. Template render and
   * TypeScript `ctx.env` read through its view; expression sites call
   * `recordExpressionEnvironment`. Absent when the caller did not open a load
   * context (tests may create one via `recordEnvironment`).
   */
  readonly environmentRecorder?: EnvironmentRecorder;
  readonly appRoot: string;
  readonly layer: LandofileLayer;
  readonly policy: LandofileLoadPolicy;
  readonly logger?: Context.Service.Shape<typeof Logger> | undefined;
}

const transactionGuard = Effect.fnUntraced(function* (
  inputs?: Pick<LandofileRuntimeInputs, "transactionGuard">,
) {
  const option =
    inputs?.transactionGuard === undefined
      ? yield* Effect.serviceOption(ManagedFileTransactionGuard)
      : undefined;
  return inputs?.transactionGuard ?? (option?._tag === "Some" ? option.value : undefined);
});

export const ensureConsistentRoot = Effect.fnUntraced(function* (
  appRoot: string,
  inputs?: Pick<LandofileRuntimeInputs, "transactionGuard" | "readOnly">,
) {
  const guard = yield* transactionGuard(inputs);
  if (guard !== undefined)
    yield* inputs?.readOnly ? guard.assertReadable(appRoot) : guard.ensureConsistent(appRoot);
});

export const assertReadableRoot = Effect.fnUntraced(function* (
  appRoot: string,
  inputs?: Pick<LandofileRuntimeInputs, "transactionGuard">,
) {
  const guard = yield* transactionGuard(inputs);
  if (guard !== undefined) yield* guard.assertReadable(appRoot);
});

/**
 * Open a load context. Prefer an explicit captured `env` from the invocation;
 * the default only remains for embedders that have not yet plumbed capture.
 */
export const loadContext = Effect.fnUntraced(function* (
  appRoot: string,
  env?: Readonly<Record<string, string | undefined>>,
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
  const captured = hostExpressionEnvironment(env);
  const environmentRecorder = recordEnvironment(captured);
  return {
    appRoot,
    policy,
    pendingSites: [],
    recorder: createLoadFailureRecorder(),
    compilationContext: captureCompilationContext(appRoot, captured),
    environmentRecorder,
    ...(logger._tag === "Some" ? { logger: logger.value } : {}),
  };
});
