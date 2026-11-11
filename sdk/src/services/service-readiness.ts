import { Context, type Effect } from "effect";
import type { HealthcheckTargetUnsupportedError, ServiceNotReadyError } from "../errors/index.ts";
import type { AppPlan, ServiceName } from "../schema/index.ts";
import type { RuntimeProviderShape } from "./provider.ts";

/** Wait for the selected services' effective readiness in an already applied plan. */
export class ServiceReadiness extends Context.Service<
  ServiceReadiness,
  {
    readonly wait: (options: {
      readonly provider: RuntimeProviderShape;
      readonly plan: AppPlan;
      readonly services: ReadonlyArray<ServiceName>;
    }) => Effect.Effect<void, ServiceNotReadyError | HealthcheckTargetUnsupportedError>;
  }
>()("@lando/core/ServiceReadiness") {}
