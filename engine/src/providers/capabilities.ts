/**
 * `ProviderCapabilities` schema and matchers.
 *
 * Capabilities are a typed manifest of what the provider can do. Planning
 * consults capabilities before assembling an `AppPlan`, and emits actionable
 * errors when a feature is requested that the provider can't honor.
 *
 * If a service, recipe, or subsystem requires a missing capability, planning
 * fails with `CapabilityError` containing the service, feature, capability,
 * provider id, and a suggested fix.
 */
export { ProviderCapabilities } from "@lando/sdk/schema";
