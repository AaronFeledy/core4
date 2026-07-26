import { Schema } from "effect";

export const ServiceDependencyCondition = Schema.Literal(
  "service_started",
  "service_healthy",
  "service_completed_successfully",
).annotations({
  identifier: "ServiceDependencyCondition",
  title: "Service Dependency Condition",
  description:
    "How a service dependency must be satisfied before dependents start: on process start, on healthcheck success, or on successful completion.",
});
export type ServiceDependencyCondition = typeof ServiceDependencyCondition.Type;
