import type { AppPlan } from "@lando/sdk/schema";

import { GLOBAL_APP_ID } from "../global-app/service.ts";
import { SCRATCH_EXTENSION_KEY } from "../scratch-app/identity.ts";

export type BuildAppKind = "user" | "scratch" | "global";

/**
 * Scratch ownership is declared by the plan extension the scratch service stamps, the same marker
 * app mutation locks use. An id prefix is not ownership: a user app may be named `scratch-*`.
 */
export const isScratchPlan = (plan: AppPlan): boolean =>
  Object.hasOwn(plan.extensions, SCRATCH_EXTENSION_KEY);

export const buildAppKind = (plan: AppPlan): BuildAppKind =>
  String(plan.id) === GLOBAL_APP_ID ? "global" : isScratchPlan(plan) ? "scratch" : "user";
