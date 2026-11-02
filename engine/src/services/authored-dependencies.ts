import { type ServiceConfig, ServiceName, type ServicePlan } from "@lando/sdk/schema";

export const applyAuthoredDependencies = (servicePlan: ServicePlan, service: ServiceConfig): ServicePlan => {
  const authoredDependencies = new Map(
    (service.dependsOn ?? []).map((dependency) => [
      dependency.service,
      {
        service: ServiceName.make(dependency.service),
        condition: dependency.condition ?? "service_started",
        required: dependency.required ?? true,
      },
    ]),
  );
  if (authoredDependencies.size === 0) return servicePlan;

  const contributedServices = new Set(servicePlan.dependsOn.map((dependency) => dependency.service));
  return {
    ...servicePlan,
    dependsOn: [
      ...servicePlan.dependsOn.map(
        (dependency) => authoredDependencies.get(dependency.service) ?? dependency,
      ),
      ...[...authoredDependencies]
        .filter(([service]) => !contributedServices.has(ServiceName.make(service)))
        .map(([, dependency]) => dependency),
    ],
  };
};
