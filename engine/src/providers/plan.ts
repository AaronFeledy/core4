/**
 * `AppPlan` schema.
 *
 * The app plan is a frozen, schema-validated, provider-neutral description
 * of what the provider must realize. It crosses the core↔provider boundary.
 * Providers MAY translate this into their own native representation
 * (compose files, pod specs, Vagrantfiles) but the *truth* lives in the plan.
 *
 * The full `ServicePlan` and `AppPlan` shapes land in `@lando/sdk/schema`
 * as the planner stabilizes. This file re-exports the stub forms.
 */
export { AppPlan, ServicePlan } from "@lando/sdk/schema";
