import { Context, type Effect } from "effect";
import type { AppPlan } from "../schema/index.ts";
import type { ProviderError, RuntimeProviderShape } from "./provider.ts";

/** Plugin-facing preparation for app output; never resolves or persists secret-store values. */
export class AppOutputRedaction extends Context.Service<
  AppOutputRedaction,
  {
    readonly register: (plan: AppPlan, provider: RuntimeProviderShape) => Effect.Effect<void, ProviderError>;
  }
>()("@lando/core/AppOutputRedaction") {}
