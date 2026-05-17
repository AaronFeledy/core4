import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";

import { Effect, Either, Schema } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import { type AppId, AppPlan } from "@lando/sdk/schema";

const PROVIDER_ID = "lando";
const APPLIED_STATE_VERSION = 1;

const trimTrailingSlashes = (path: string): string => path.replace(/\/+$/u, "");

export const appliedPlansDir = (stateDir: string): string =>
  `${trimTrailingSlashes(stateDir)}/provider-lando/apps`;

export const appliedPlanPath = (stateDir: string, appId: AppId): string =>
  `${appliedPlansDir(stateDir)}/${appId}.json`;

// Versioned JSON envelope. Provider state lives under `<userDataRoot>` and is
// not on the hot path, so JSON encoding is permitted with a schema version
// header that triggers invalidation on mismatch.
interface AppliedPlanEnvelope {
  readonly version: typeof APPLIED_STATE_VERSION;
  readonly providerId: typeof PROVIDER_ID;
  readonly appId: AppId;
  readonly plan: typeof AppPlan.Encoded;
}

const encodePlanEnvelope = (plan: AppPlan): AppliedPlanEnvelope => ({
  version: APPLIED_STATE_VERSION,
  providerId: PROVIDER_ID,
  appId: plan.id,
  plan: Schema.encodeSync(AppPlan)(plan),
});

export const persistAppliedPlan = (
  stateDir: string,
  plan: AppPlan,
): Effect.Effect<string, ProviderUnavailableError> =>
  Effect.tryPromise({
    try: async () => {
      const dir = appliedPlansDir(stateDir);
      const path = appliedPlanPath(stateDir, plan.id);
      await mkdir(dir, { recursive: true });
      await writeFile(path, `${JSON.stringify(encodePlanEnvelope(plan), null, 2)}\n`);
      return path;
    },
    catch: (cause) =>
      new ProviderUnavailableError({
        providerId: PROVIDER_ID,
        operation: "applied-state.persist",
        message: "Unable to write provider-lando applied plan state.",
        remediation: `Check permissions for ${stateDir} and rerun the failing lifecycle command.`,
        cause,
      }),
  });

const readPlanFile = (path: string): Effect.Effect<string | undefined, never> =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) => cause,
  }).pipe(
    Effect.map((content) => content as string | undefined),
    Effect.catchAll(() => Effect.succeed(undefined)),
  );

// Returns `undefined` for missing files, malformed JSON, unknown envelope
// versions, and schema decode failures so stale or corrupt state files behave
// as cache misses rather than hard errors.
export const loadAppliedPlan = (stateDir: string, appId: AppId): Effect.Effect<AppPlan | undefined, never> =>
  Effect.gen(function* () {
    const content = yield* readPlanFile(appliedPlanPath(stateDir, appId));
    if (content === undefined) return undefined;

    const parsed = Either.try({
      try: () => JSON.parse(content) as unknown,
      catch: (cause) => cause,
    });
    if (Either.isLeft(parsed)) return undefined;

    const envelope = parsed.right;
    if (
      typeof envelope !== "object" ||
      envelope === null ||
      !("version" in envelope) ||
      envelope.version !== APPLIED_STATE_VERSION ||
      !("plan" in envelope)
    ) {
      return undefined;
    }

    const decoded = Schema.decodeUnknownEither(AppPlan)(envelope.plan);
    return Either.isRight(decoded) ? decoded.right : undefined;
  });

export const removeAppliedPlan = (stateDir: string, appId: AppId): Effect.Effect<void, never> =>
  Effect.tryPromise({
    try: () => unlink(appliedPlanPath(stateDir, appId)),
    catch: (cause) => cause,
  }).pipe(
    Effect.asVoid,
    Effect.catchAll(() => Effect.void),
  );
