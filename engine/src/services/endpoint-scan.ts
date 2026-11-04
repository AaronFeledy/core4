import {
  type EndpointPlan,
  type EndpointRef,
  type EndpointScan,
  type ServicePlan,
  logicalEndpointIdentity,
} from "@lando/sdk/schema";

export const endpointScanPolicies = (
  endpoints: readonly EndpointPlan[],
): ReadonlyMap<string, EndpointScan> => {
  const policies = new Map<string, EndpointScan>();
  for (const endpoint of endpoints) {
    if (endpoint.scan === undefined) continue;
    const identity = logicalEndpointIdentity(endpoint);
    policies.set(identity, { ...policies.get(identity), ...endpoint.scan });
  }
  return policies;
};

export const endpointScanPolicy = (
  service: ServicePlan | undefined,
  endpoint: EndpointRef | undefined,
): EndpointScan | undefined =>
  service === undefined || endpoint === undefined
    ? undefined
    : endpointScanPolicies(service.endpoints).get(logicalEndpointIdentity(endpoint));
