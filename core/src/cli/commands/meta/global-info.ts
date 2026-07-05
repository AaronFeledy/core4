import { Effect } from "effect";

import type { InfoAppError, InfoAppResult } from "@lando/sdk/app";
import { ToolingExecError } from "@lando/sdk/errors";
import type { AppPlan } from "@lando/sdk/schema";
import type { RuntimeProviderRegistry } from "@lando/sdk/services";

import type { RenderContext } from "../../renderer-boundary.ts";
import { AppInfoResultSchema, infoForPlan, renderInfoAppResult } from "../info.ts";
import { type LoadGlobalPlanError, type LoadGlobalPlanServices, loadGlobalPlan } from "./global-plan.ts";

export interface GlobalInfoOptions {
  readonly services?: ReadonlyArray<string>;
}

export type GlobalInfoResult = InfoAppResult;
export const GlobalInfoResultSchema = AppInfoResultSchema;

export type GlobalInfoError = InfoAppError | LoadGlobalPlanError | ToolingExecError;
export type GlobalInfoServices = LoadGlobalPlanServices | RuntimeProviderRegistry;

export const renderGlobalInfoResult = (result: GlobalInfoResult, ctx?: RenderContext): string =>
  renderInfoAppResult(result, ctx);

const availableServiceList = (plan: AppPlan): string =>
  Object.values(plan.services)
    .map((service) => String(service.name))
    .sort()
    .join(", ");

const selectPlanForServices = (
  plan: AppPlan,
  requested: ReadonlyArray<string> | undefined,
): Effect.Effect<AppPlan, ToolingExecError> => {
  if (requested === undefined || requested.length === 0) return Effect.succeed(plan);
  const names = new Set(Object.values(plan.services).map((service) => String(service.name)));
  const missing = requested.find((service) => !names.has(service));
  if (missing !== undefined) {
    const list = availableServiceList(plan);
    return Effect.fail(
      new ToolingExecError({
        message:
          list.length === 0
            ? `meta:global:info: service ${missing} is not in the global app plan.`
            : `meta:global:info: service ${missing} is not in the global app plan (available: ${list}).`,
        tool: "meta:global:info",
      }),
    );
  }
  const requestedSet = new Set(requested);
  return Effect.succeed({
    ...plan,
    services: Object.fromEntries(
      Object.entries(plan.services).filter(([, service]) => requestedSet.has(String(service.name))),
    ),
  });
};

export const globalInfo = (
  options: GlobalInfoOptions = {},
): Effect.Effect<GlobalInfoResult, GlobalInfoError, GlobalInfoServices> =>
  Effect.gen(function* () {
    const loaded = yield* loadGlobalPlan();
    if (!loaded.materialized) return { app: "global", services: [] };
    const plan = yield* selectPlanForServices(loaded.plan, options.services);
    return yield* infoForPlan(plan);
  });
