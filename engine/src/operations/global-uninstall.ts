import { Effect, Schema } from "effect";

import { GlobalAppError } from "@lando/sdk/errors";
import { GlobalAppService, PluginRegistry } from "@lando/sdk/services";

import {
  seedGlobalEnablement,
  selectGlobalContributions,
  withGlobalMutation,
} from "../global-app/enablement.ts";
import { bundledFirstGlobalServiceLoader } from "../services/bundled-global-service-loader.ts";
import { materializeGlobalServices, resolveGlobalServiceContributions } from "../services/global-services.ts";
import {
  executeGlobalStopSelection,
  resolveGlobalStopSelection,
  resolveGlobalTeardown,
} from "./global-teardown.ts";

export interface GlobalUninstallOptions {
  readonly plugin?: string;
}

export const GlobalUninstallResultSchema = Schema.Struct({
  app: Schema.String,
  materialized: Schema.Boolean,
  dist: Schema.Struct({
    path: Schema.String,
    status: Schema.Literals(["created", "updated", "unchanged"]),
    serviceIds: Schema.Array(Schema.String),
  }),
  contributionsDisabled: Schema.Array(Schema.String),
  servicesRemoved: Schema.Array(Schema.String),
});
export type GlobalUninstallResult = typeof GlobalUninstallResultSchema.Type;

export const globalUninstall = Effect.fn("AppOperation.globalUninstall")(
  function* (options: GlobalUninstallOptions = {}) {
    const plugins = yield* PluginRegistry;
    const manifests = yield* plugins.list;
    const contributions = yield* resolveGlobalServiceContributions(manifests);
    const selected = yield* selectGlobalContributions(contributions, options.plugin);
    const ids = selected.map((entry) => entry.contribution.id);
    const resolved = yield* resolveGlobalTeardown();
    if (resolved.evidence.kind === "orphans") {
      return yield* Effect.fail(
        new GlobalAppError({
          operation: "uninstall",
          message: "Global contribution disablement needs matching applied state for existing containers.",
          remediation: "Run `lando global:stop` to remove orphaned global containers, then retry uninstall.",
        }),
      );
    }
    const applied = resolved.evidence.kind === "applied" ? resolved.evidence.plan : undefined;
    const appliedIds = ids.filter((id) =>
      Object.values(applied?.services ?? {}).some((service) => service.name === id),
    );
    const enablement = yield* seedGlobalEnablement(contributions, { ids, enabled: false });
    return yield* Effect.gen(function* () {
      const selection =
        appliedIds.length === 0
          ? undefined
          : yield* resolveGlobalStopSelection(resolved, appliedIds, { requireOnline: true });
      const services = yield* materializeGlobalServices({
        manifests,
        enablement,
        providerCapabilities: resolved.provider.capabilities,
        providerId: resolved.provider.id,
        loadServiceConfig: bundledFirstGlobalServiceLoader.load,
      });
      const globalApp = yield* GlobalAppService;
      const dist = yield* globalApp.regenerateDist({ services });
      const stopped =
        selection === undefined ? { services: [] } : yield* executeGlobalStopSelection(resolved, selection);
      return {
        app: "global",
        materialized: resolved.materialized,
        dist,
        contributionsDisabled: ids,
        servicesRemoved: stopped.services,
      };
    }).pipe(
      Effect.mapError(
        (cause) =>
          new GlobalAppError({
            operation: "uninstall",
            message: "Global contribution disablement was saved, but reconciliation did not complete.",
            remediation:
              "Disabled services will not be started automatically. Fix the underlying error, then repeat this uninstall command to finish regenerating configuration and stopping services.",
            cause,
          }),
      ),
    );
  },
  (effect, _options: GlobalUninstallOptions = {}) => withGlobalMutation(effect),
);
