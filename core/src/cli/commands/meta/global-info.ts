import { Effect } from "effect";

import type { InfoAppError } from "@lando/sdk/app";
import type {
  ComposeKeyRejectedError,
  LandofileLoadExpressionError,
  ToolingExecError,
} from "@lando/sdk/errors";
import type { AppPlan, InfoAppResult } from "@lando/sdk/schema";
import type { RuntimeProviderRegistry } from "@lando/sdk/services";

import { selectGlobalServices } from "@lando/engine/operations/global-common";
import {
  type LoadGlobalPlanServices,
  type LoadObservedGlobalPlanError,
  loadObservedGlobalPlan,
} from "@lando/engine/operations/global-plan";
import { infoForPlan } from "@lando/engine/operations/info";
import type { RenderContext } from "../../renderer-boundary";
import { renderInfoAppResult } from "../info-render";

export interface GlobalInfoOptions {
  readonly services?: ReadonlyArray<string>;
}

export type GlobalInfoResult = InfoAppResult;

export type GlobalInfoError =
  | ComposeKeyRejectedError
  | InfoAppError
  | LoadObservedGlobalPlanError
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
  const loaded = yield* loadObservedGlobalPlan();
  if (!loaded.materialized) return { app: "global", services: [] };
  const plan = yield* selectPlanForServices(loaded.plan, options.services);
  return yield* infoForPlan(plan);
});
