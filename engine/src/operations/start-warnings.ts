import type { AppPlan, CommandWarning } from "@lando/sdk/schema";
import { publishCommandWarnings } from "../landofile/command-warnings.ts";
import { selectHelperCommandWarnings } from "./helper-command-warning.ts";
import { selectLowPortWarnings } from "./low-port-warning.ts";

/** The advisories a plan's services earn when their containers are created. */
export const selectStartWarnings = (plan: AppPlan): readonly CommandWarning[] => [
  ...selectLowPortWarnings(plan),
  ...selectHelperCommandWarnings(plan),
];

/**
 * Every operation that creates or recreates service containers publishes these for the plan it
 * will apply, before its hooks and builds, so a failing build still reports them.
 */
export const publishStartWarnings = (plan: AppPlan) => publishCommandWarnings(selectStartWarnings(plan));
