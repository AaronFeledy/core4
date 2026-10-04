import { Effect } from "effect";

import type { InfoAppError, InfoAppResult } from "@lando/sdk/app";
import type {
  ComposeKeyRejectedError,
  LandofileLoadExpressionError,
  ToolingExecError,
} from "@lando/sdk/errors";
import type { AppPlan } from "@lando/sdk/schema";
import type { RuntimeProviderRegistry } from "@lando/sdk/services";

import {
  type LoadGlobalPlanError,
  type LoadGlobalPlanServices,
  loadGlobalPlan,
} from "@lando/engine/operations/global-plan";
import { AppInfoResultSchema, infoForPlan } from "@lando/engine/operations/info";
import type { RenderContext } from "../../renderer-boundary";
import { renderInfoAppResult } from "../info-render";
import { selectGlobalServices } from "./global-common";

export interface GlobalInfoOptions {
  readonly services?: ReadonlyArray<string>;
}

export type GlobalInfoResult = InfoAppResult;
export const GlobalInfoResultSchema = AppInfoResultSchema;

export type GlobalInfoError =
  | ComposeKeyRejectedError
  | InfoAppError
  | LoadGlobalPlanError
  | ToolingExecError
  | LandofileLoadExpressionError;
export type GlobalInfoServices = LoadGlobalPlanServices | RuntimeProviderRegistry;

export const renderGlobalInfoResult = (result: GlobalInfoResult, ctx?: RenderContext): string =>
  renderInfoAppResult(result, ctx);

const selectPlanForServices = (
  plan: AppPlan,
  requested: ReadonlyArray<string> | undefined,
): Effect.Effect<AppPlan, ToolingExecError> => {
  if (requested === undefined || requested.length === 0) return Effect.succeed(plan);
  return selectGlobalServices({
    commandId: "meta:global:info",
    services: plan.services,
    requested,
    expandDependencies: false,
  }).pipe(
    Effect.map((selected) => ({
      ...plan,
      services: Object.fromEntries(
        Object.entries(plan.services).filter(([, service]) => selected.includes(service)),
      ),
    })),
  );
};

export const globalInfo = Effect.fn("GlobalInfo.info")(function* (
  options: GlobalInfoOptions = {},
): Effect.fn.Return<GlobalInfoResult, GlobalInfoError, GlobalInfoServices> {
  const loaded = yield* loadGlobalPlan();
  if (!loaded.materialized) return { app: "global", services: [] };
  const plan = yield* selectPlanForServices(loaded.plan, options.services);
  return yield* infoForPlan(plan);
});
