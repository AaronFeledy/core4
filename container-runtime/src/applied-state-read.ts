import {
  type AppliedStateVersionError,
  ProviderUnavailableError,
  type StateStoreError,
  appliedStateVersionError,
} from "@lando/sdk/errors";
import type { AppId, AppliedAppPlan, UnreadableAppliedState } from "@lando/sdk/schema";
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
): DecodeDetail | undefined => {
  const { cause } = error;
  const expectedVersion = APPLIED_STATE_VERSION;
  if (cause instanceof AppliedStateMigrationError) {
    return { foundVersion: cause.foundVersion, expectedVersion, coordinate: cause.coordinate };
  }
  if (error.reason !== "decode" || error.operation !== "get") return undefined;
  return Schema.isSchemaError(cause)
    ? { foundVersion: expectedVersion, expectedVersion, coordinate: annotatedCoordinate(cause.issue) ?? root }
    : { foundVersion: null, expectedVersion, coordinate: "envelope" };
};

type AppliedPlanReadFailure =
  | { readonly status: "unreadable"; readonly path: string; readonly detail?: DecodeDetail }
  | {
      readonly status: "newer-version";
      readonly path: string;
      readonly storedVersion: number;
      readonly supportedVersion: number;
    };

export type AppliedPlanRead =
  | { readonly status: "missing" }
  | { readonly status: "readable"; readonly plan: AppliedAppPlan }
  | AppliedPlanReadFailure;

type AppliedPlansRecordRead =
  | { readonly status: "readable"; readonly plans: Readonly<Record<AppId, AppliedAppPlan>> | null }
  | AppliedPlanReadFailure;

export const classifyAppliedStateStoreError = (
  error: StateStoreError,
  root: "plan" | "apps",
  fallbackPath: string,
): AppliedPlanReadFailure => {
  const { reason, storedVersion, supportedVersion } = error;
  const path = error.path ?? fallbackPath;
  if (reason === "newer-version" && storedVersion !== undefined && supportedVersion !== undefined) {
    return { status: "newer-version", path, storedVersion, supportedVersion };
  }
  const detail = appliedStateDecodeDetail(error, root);
  return { status: "unreadable", path, ...(detail === undefined ? {} : { detail }) };
};

type ReadErrorContext = {
  readonly providerId: string;
  readonly layout: "per-app" | "record";
  readonly operation?: "read" | "persist" | "remove";
  readonly appId?: string;
  readonly cause?: unknown;
};

export const unreadableAppliedStateError = (
  input: ReadErrorContext & {
    readonly path: string;
    readonly detail?: DecodeDetail;
  },
) =>
  new ProviderUnavailableError({
    providerId: input.providerId,
    operation: `applied-state.${input.operation ?? "read"}`,
    message: `The applied provider state file "${input.path}" is unreadable; refusing to mutate runtime resources.${input.detail === undefined ? "" : ` Found ${input.detail.foundVersion === null ? "an unreadable version" : `v${input.detail.foundVersion}`}, expected v${input.detail.expectedVersion}; invalid at ${input.detail.coordinate}.`}${input.layout === "record" ? " This file contains state for several apps; no app in this record can be safely mutated." : ""}`,
    details: { path: input.path, ...input.detail },
    remediation: `Restore "${input.path}" from backup; or, accepting that unflushed accelerated sync changes may be lost, move it aside and rerun ${input.appId === "global" ? "`lando global:destroy --yes`" : "`lando destroy`"}, which then cleans up by ownership labels.${input.layout === "record" ? " Moving this file aside affects every app in the record." : ""}`,
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  });

export const APPLIED_PLANS_KEY = "applied-plans.json";

export const appliedStateInspectError = (
  input: ReadErrorContext & {
    readonly read: AppliedPlanReadFailure;
  },
): ProviderUnavailableError | AppliedStateVersionError => {
  const { read, providerId, operation, layout, appId, cause } = input;
  switch (read.status) {
    case "newer-version":
      return appliedStateVersionError({
        providerId,
        operation: `applied-state.${operation ?? "read"}`,
        path: read.path,
        storedVersion: read.storedVersion,
        supportedVersion: read.supportedVersion,
        scope: layout === "record" ? "provider" : "app",
        ...(appId === undefined ? {} : { appId }),
        ...(cause === undefined ? {} : { cause }),
      });
    case "unreadable":
      return unreadableAppliedStateError({
        providerId,
        layout,
        path: read.path,
        ...(operation === undefined ? {} : { operation }),
        ...(appId === undefined ? {} : { appId }),
        ...(read.detail === undefined ? {} : { detail: read.detail }),
      });
    default:
      return read satisfies never;
  }
};

export const unreadableEntryFromRead = (
  read: AppliedPlanReadFailure,
  appId?: AppId,
): UnreadableAppliedState => {
  const location = { path: read.path, ...(appId === undefined ? {} : { appId }) };
  switch (read.status) {
    case "newer-version":
      return {
        ...location,
        reason: "newer-version",
        storedVersion: read.storedVersion,
        supportedVersion: read.supportedVersion,
      };
    case "unreadable":
      return { ...location, reason: "unreadable" };
    default:
      return read satisfies never;
  }
};

const inspectBucket = <A, B>(
  open: Effect.Effect<StateBucket<A>, StateStoreError>,
  location: { readonly root: "plan" | "apps"; readonly fallbackPath: string },
  read: (exists: boolean, value: A | null, path: string) => B,
): Effect.Effect<B | AppliedPlanReadFailure> =>
  open.pipe(
    Effect.flatMap((bucket) =>
      bucket.exists.pipe(
        Effect.flatMap((exists) =>
          exists
            ? bucket.get.pipe(Effect.map((value) => read(true, value, bucket.path)))
            : Effect.succeed(read(false, null, bucket.path)),
        ),
        Effect.catch((error) =>
          Effect.succeed(classifyAppliedStateStoreError(error, location.root, bucket.path)),
        ),
      ),
    ),
    Effect.catch((error) =>
      Effect.succeed(classifyAppliedStateStoreError(error, location.root, location.fallbackPath)),
    ),
  );

export const inspectAppliedPlanBucket = (
  open: Effect.Effect<StateBucket<AppliedAppPlan>, StateStoreError>,
  fallbackPath: string,
): Effect.Effect<AppliedPlanRead> =>
  inspectBucket(open, { root: "plan", fallbackPath }, (exists, value, path): AppliedPlanRead => {
    if (!exists) return { status: "missing" };
    if (value === null) return { status: "unreadable", path };
    return { status: "readable", plan: value };
  });

export const inspectAppliedPlansRecordBucket = (
  open: Effect.Effect<StateBucket<Readonly<Record<AppId, AppliedAppPlan>>>, StateStoreError>,
  fallbackPath: string,
): Effect.Effect<AppliedPlansRecordRead> =>
  inspectBucket(
    open,
    { root: "apps", fallbackPath },
    (exists, value, path): AppliedPlansRecordRead =>
      exists && value === null ? { status: "unreadable", path } : { status: "readable", plans: value },
  );
