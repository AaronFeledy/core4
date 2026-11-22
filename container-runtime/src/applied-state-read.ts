import { ProviderUnavailableError, StateStoreError } from "@lando/sdk/errors";
import type { AppId, AppliedAppPlan } from "@lando/sdk/schema";
import type { StateBucket } from "@lando/sdk/services";
import { Effect, Schema, SchemaIssue } from "effect";
import { APPLIED_STATE_VERSION } from "./applied-state-migrate.ts";

type DecodeDetail = {
  readonly foundVersion: number | null;
  readonly expectedVersion: number;
  readonly coordinate: string;
};

export class AppliedStateMigrationError extends Error {
  constructor(
    readonly foundVersion: number,
    readonly coordinate: string,
  ) {
    super(`Cannot read applied state v${foundVersion} as v${APPLIED_STATE_VERSION}: ${coordinate}.`);
  }
}

const coordinateAnnotation = "appliedStateCoordinate";

export const appliedStateIssue = (coordinate: string) =>
  new SchemaIssue.InvalidValue({
    [coordinateAnnotation]: coordinate,
    message: `Invalid applied state at ${coordinate}.`,
  });

const annotatedCoordinate = (issue: SchemaIssue.Issue): string | undefined => {
  switch (issue._tag) {
    case "InvalidValue": {
      const coordinate = issue.annotations?.[coordinateAnnotation];
      return typeof coordinate === "string" ? coordinate : undefined;
    }
    case "Composite":
      return issue.issues.map(annotatedCoordinate).find((coordinate) => coordinate !== undefined);
    case "Encoding":
    case "Filter":
      return annotatedCoordinate(issue.issue);
    default:
      return undefined;
  }
};

const appliedStateDecodeDetail = (
  error: StateStoreError,
  root: "plan" | "apps",
): { readonly detail?: DecodeDetail } => {
  const { cause } = error;
  const expectedVersion = APPLIED_STATE_VERSION;
  if (cause instanceof AppliedStateMigrationError) {
    return { detail: { foundVersion: cause.foundVersion, expectedVersion, coordinate: cause.coordinate } };
  }
  if (error.reason !== "decode" || error.operation !== "get") return {};
  return Schema.isSchemaError(cause)
    ? {
        detail: {
          foundVersion: expectedVersion,
          expectedVersion,
          coordinate: annotatedCoordinate(cause.issue) ?? root,
        },
      }
    : { detail: { foundVersion: null, expectedVersion, coordinate: "envelope" } };
};

export type AppliedPlanRead =
  | { readonly status: "missing" }
  | { readonly status: "readable"; readonly plan: AppliedAppPlan }
  | { readonly status: "unreadable"; readonly path: string; readonly detail?: DecodeDetail };

export const unreadableAppliedStateError = (input: {
  readonly providerId: string;
  readonly path: string;
  readonly layout: "per-app" | "record";
  readonly detail?: DecodeDetail;
  readonly operation?: "persist" | "remove";
  /** The app whose record is unreadable; the global app is cleaned up by its own command. */
  readonly appId?: string;
}) =>
  new ProviderUnavailableError({
    providerId: input.providerId,
    operation: `applied-state.${input.operation ?? "read"}`,
    message: `The applied provider state file "${input.path}" is unreadable; refusing to mutate runtime resources.${input.detail === undefined ? "" : ` Found ${input.detail.foundVersion === null ? "an unreadable version" : `v${input.detail.foundVersion}`}, expected v${input.detail.expectedVersion}; invalid at ${input.detail.coordinate}.`}${input.layout === "record" ? " This file contains state for several apps; no app in this record can be safely mutated." : ""}`,
    ...(input.detail === undefined ? {} : { details: { path: input.path, ...input.detail } }),
    remediation: `Restore "${input.path}" from backup; or, accepting that unflushed accelerated sync changes may be lost, move it aside and rerun ${input.appId === "global" ? "`lando global:destroy --yes`" : "`lando destroy`"}, which then cleans up by ownership labels.${input.layout === "record" ? " Moving this file aside affects every app in the record." : ""}`,
  });

export const APPLIED_PLANS_KEY = "applied-plans.json";

export const unreadableAppliedPlansMutation = (
  error: StateStoreError,
  owner: { readonly providerId: string; readonly operation?: "persist" | "remove" },
) => {
  const { detail } = appliedStateDecodeDetail(error, "apps");
  return detail === undefined
    ? undefined
    : unreadableAppliedStateError({
        ...owner,
        layout: "record",
        path: error.path ?? APPLIED_PLANS_KEY,
        detail,
      });
};

export const appliedPlansPruneError = (error: StateStoreError) => {
  const cause = unreadableAppliedPlansMutation(error, { providerId: "podman", operation: "remove" });
  if (cause === undefined) return error;
  return new StateStoreError({
    reason: error.reason,
    operation: error.operation,
    path: error.path ?? APPLIED_PLANS_KEY,
    remediation: cause.remediation,
    cause,
  });
};

const inspectBucket = <A>(bucket: StateBucket<A>) =>
  bucket.exists.pipe(
    Effect.flatMap((exists) =>
      exists
        ? bucket.get.pipe(Effect.map((value) => ({ exists: true, value })))
        : Effect.succeed({ exists: false, value: null }),
    ),
  );

export const inspectAppliedPlanBucket = (
  open: Effect.Effect<StateBucket<AppliedAppPlan>, StateStoreError>,
  fallbackPath: string,
): Effect.Effect<AppliedPlanRead> =>
  open.pipe(
    Effect.flatMap((bucket) =>
      inspectBucket(bucket).pipe(
        Effect.map(({ exists, value }): AppliedPlanRead => {
          if (!exists) return { status: "missing" };
          if (value === null) return { status: "unreadable", path: bucket.path };
          return { status: "readable", plan: value };
        }),
        Effect.catch((error) =>
          Effect.succeed<AppliedPlanRead>({
            status: "unreadable",
            path: bucket.path,
            ...appliedStateDecodeDetail(error, "plan"),
          }),
        ),
      ),
    ),
    Effect.catch((cause) =>
      Effect.succeed<AppliedPlanRead>({ status: "unreadable", path: cause.path ?? fallbackPath }),
    ),
  );

export const inspectAppliedPlansRecordBucket = (
  open: Effect.Effect<StateBucket<Readonly<Record<AppId, AppliedAppPlan>>>, StateStoreError>,
  fallbackPath: string,
) =>
  open.pipe(
    Effect.flatMap((bucket) =>
      inspectBucket(bucket).pipe(
        Effect.map(({ exists, value }) =>
          exists && value === null
            ? { status: "unreadable" as const, path: bucket.path }
            : { status: "readable" as const, plans: value },
        ),
        Effect.catch((error) =>
          Effect.succeed({
            status: "unreadable" as const,
            path: bucket.path,
            ...appliedStateDecodeDetail(error, "apps"),
          }),
        ),
      ),
    ),
    Effect.catch((cause) =>
      Effect.succeed({ status: "unreadable" as const, path: cause.path ?? fallbackPath }),
    ),
  );
