import { readdir } from "node:fs/promises";

import { Effect, Option, Schema } from "effect";

import { type ProviderUnavailableError, isErrnoCode } from "@lando/sdk/errors";
import { AppId, type AppliedStateInventory } from "@lando/sdk/schema";
import type { AppliedPlanRead } from "./applied-state-read.ts";

export const APPLIED_PLAN_NAMESPACE = "applied-plans";

export const appliedPlansDir = (stateDir: string): string =>
  `${stateDir.replace(/\/+$/u, "")}/${APPLIED_PLAN_NAMESPACE}`;

export const appliedPlanPath = (stateDir: string, appId: AppId): string =>
  `${appliedPlansDir(stateDir)}/${appId}.json`;

export const listAppliedPlanInventory = (
  stateDir: string,
  inspect: (appId: AppId) => Effect.Effect<AppliedPlanRead>,
  onError: (cause: unknown) => ProviderUnavailableError,
) =>
  Effect.tryPromise({ try: () => readdir(appliedPlansDir(stateDir)), catch: (cause) => cause }).pipe(
    Effect.catchIf(
      (cause: unknown) => isErrnoCode(cause, "ENOENT"),
      () => Effect.succeed([]),
    ),
    Effect.mapError(onError),
    Effect.map((entries) =>
      entries.flatMap((entry) => {
        if (!entry.endsWith(".json")) return [];
        return Option.match(Schema.decodeUnknownOption(AppId)(entry.slice(0, -5)), {
          onNone: () => [],
          onSome: (appId) => [appId],
        });
      }),
    ),
    Effect.flatMap((ids) =>
      Effect.forEach(ids, (appId) => inspect(appId).pipe(Effect.map((read) => ({ appId, read })))),
    ),
    Effect.map(
      (reads): AppliedStateInventory => ({
        plans: reads.flatMap(({ read }) => (read.status === "readable" ? [read.plan] : [])),
        unreadable: reads.flatMap(({ appId, read }) =>
          read.status === "unreadable" ? [{ appId, path: read.path }] : [],
        ),
      }),
    ),
  );
