import { Effect } from "effect";

import { ProviderUnavailableError, type StateStoreError } from "@lando/sdk/errors";
import type { AppId, AppPlan } from "@lando/sdk/schema";
import type { StateBucket } from "@lando/sdk/services";

export type AppliedPlanRead =
  | { readonly status: "missing" }
  | { readonly status: "readable"; readonly plan: AppPlan }
  | { readonly status: "unreadable"; readonly path: string };

export const unreadableAppliedStateError = (input: {
  readonly providerId: string;
  readonly path: string;
  readonly layout: "per-app" | "record";
}) =>
  new ProviderUnavailableError({
    providerId: input.providerId,
    operation: "applied-state.read",
    message: `The applied provider state file "${input.path}" is unreadable; refusing to mutate runtime resources.${input.layout === "record" ? " This file contains state for several apps; no app in this record can be safely mutated." : ""}`,
    remediation: `Restore "${input.path}" from backup; or, accepting that unflushed accelerated sync changes may be lost, move it aside and rerun \`lando destroy\`, which then cleans up by ownership labels.${input.layout === "record" ? " Moving this file aside affects every app in the record." : ""}`,
  });

const inspectBucket = <A>(bucket: StateBucket<A>) =>
  bucket.exists.pipe(
    Effect.flatMap((exists) =>
      exists
        ? bucket.get.pipe(Effect.map((value) => ({ exists: true, value })))
        : Effect.succeed({ exists: false, value: null }),
    ),
  );

export const inspectAppliedPlanBucket = (
  open: Effect.Effect<StateBucket<AppPlan | null>, StateStoreError>,
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
        Effect.catch(() => Effect.succeed<AppliedPlanRead>({ status: "unreadable", path: bucket.path })),
      ),
    ),
    Effect.catch((cause) =>
      Effect.succeed<AppliedPlanRead>({ status: "unreadable", path: cause.path ?? fallbackPath }),
    ),
  );

export const inspectAppliedPlansRecordBucket = (
  open: Effect.Effect<StateBucket<Readonly<Record<AppId, AppPlan>> | null>, StateStoreError>,
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
        Effect.catch(() => Effect.succeed({ status: "unreadable" as const, path: bucket.path })),
      ),
    ),
    Effect.catch((cause) =>
      Effect.succeed({ status: "unreadable" as const, path: cause.path ?? fallbackPath }),
    ),
  );
