import { GlobalContributionStateSchema, readGlobalResolution } from "@lando/engine/global-app/resolution";
import { makeGlobalAppService } from "@lando/engine/global-app/service";
import { readGlobalLandofile } from "@lando/engine/operations/global-plan";
import { withReadOnlyLandofile } from "@lando/engine/services/landofile-live";
import { ConfigService, FileSystem, GlobalAppService } from "@lando/sdk/services";
import { Effect, Schema } from "effect";

export const GlobalServiceListEntrySchema = GlobalContributionStateSchema;
export type GlobalServiceListEntry = typeof GlobalServiceListEntrySchema.Type;
export type GlobalServiceListState = GlobalServiceListEntry["state"];

export const GlobalListResultSchema = Schema.Struct({
  revision: Schema.Number,
  diagnostics: Schema.Array(Schema.String),
  services: Schema.Array(GlobalServiceListEntrySchema),
  retainedPolicies: Schema.Array(
    Schema.Struct({
      plugin: Schema.String,
      enabled: Schema.optionalKey(Schema.Boolean),
      contributions: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          enabled: Schema.optionalKey(Schema.Boolean),
          defaultEnabled: Schema.Boolean,
        }),
      ),
    }),
  ),
});
export type GlobalListResult = typeof GlobalListResultSchema.Type;

export const globalList = Effect.fn("GlobalList.list")(function* () {
  let resolution = yield* readGlobalResolution();
  const suppliedApp = yield* Effect.serviceOption(GlobalAppService);
  const app =
    suppliedApp._tag === "Some"
      ? suppliedApp.value
      : makeGlobalAppService(yield* ConfigService, yield* FileSystem);
  const composition = yield* Effect.result(
    withReadOnlyLandofile(
      readGlobalLandofile({ resolution }).pipe(Effect.provideService(GlobalAppService, app)),
    ),
  );
  const diagnostics: string[] = [];
  if (composition._tag === "Success" && composition.success.materialized)
    resolution = composition.success.resolution;
  if (composition._tag === "Failure")
    diagnostics.push(
      `Authored configuration could not be validated: ${composition.failure.message} Contribution rows show saved policy and plugin defaults.`,
    );
  diagnostics.push(
    ...resolution.errors.map(
      (issue) =>
        `${issue.id}: ${issue.cause.message} ${issue.cause.remediation ?? "Repair the contribution or authored configuration."}`,
    ),
  );
  const current = new Map<string, Set<string>>();
  for (const entry of resolution.entries) {
    const ids = current.get(entry.plugin) ?? new Set<string>();
    ids.add(entry.id);
    current.set(entry.plugin, ids);
  }
  const retainedPolicies = Object.entries(resolution.policy.plugins).flatMap(([plugin, policy]) => {
    const ids = current.get(plugin);
    const retained = Object.keys(policy.contributions).filter((id) => !ids?.has(id));
    return ids !== undefined && retained.length === 0
      ? []
      : [
          {
            plugin,
            ...(policy.enabled === undefined ? {} : { enabled: policy.enabled }),
            contributions: retained.sort().flatMap((id) => {
              const preference = policy.contributions[id];
              return preference === undefined ? [] : [{ id, ...preference }];
            }),
          },
        ];
  });
  return {
    revision: resolution.policy.revision,
    services: resolution.entries,
    retainedPolicies,
    diagnostics,
  };
});
