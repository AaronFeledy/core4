import { Result } from "effect";
import { LandofileValidationError } from "../errors/landofile.ts";
import {
  type AppPlan,
  type ServicePlan,
  landoAppNetworkName,
  landoServiceNetworkAliases,
  landoSharedNetworkName,
} from "./app-plan.ts";
import { logicalEndpointIdentity } from "./endpoint-selection.ts";
import type { EndpointRef } from "./endpoint.ts";

/** Startup and dependency readiness share exactly one defaulting rule. */
export const effectiveReadiness = (service: Pick<ServicePlan, "readiness" | "healthcheck">) =>
  service.readiness ?? service.healthcheck;

/** Resolve only declared listeners on managed DNS, never interface addresses or loopback. */
export const serviceListenerTarget = (
  plan: Pick<AppPlan, "slug" | "networking">,
  service: Pick<ServicePlan, "name" | "endpoints"> & Partial<Pick<ServicePlan, "hostAliases">>,
  endpoint: EndpointRef,
) => {
  const privateNetwork = landoAppNetworkName(plan);
  const network = privateNetwork ?? landoSharedNetworkName(plan);
  const host =
    privateNetwork === undefined ? landoServiceNetworkAliases(plan, service)[0] : String(service.name);
  const declared = service.endpoints.some(
    (candidate) => logicalEndpointIdentity(candidate) === logicalEndpointIdentity(endpoint),
  );
  const reservedHost =
    host !== undefined &&
    /^(?:localhost6?(?:\.localdomain6?)?\.?|ip6-localhost\.?|ip6-loopback\.?|::1|(?:0x[\da-f]+|\d+)(?:\.(?:0x[\da-f]+|\d+)){0,3})$/iu.test(
      host,
    );
  const overridden =
    service.hostAliases?.some((alias) => alias.hostname.toLowerCase() === host?.toLowerCase()) === true;
  if (!declared || network === undefined || host === undefined || reservedHost || overridden) {
    const reason = !declared
      ? "the listener is not declared"
      : network === undefined || host === undefined
        ? "no managed network realizes the listener"
        : reservedHost
          ? "the hostname is reserved or numeric, not managed service DNS"
          : "a host alias overrides managed service DNS";
    return Result.fail(
      new LandofileValidationError({
        file: ".lando.yml",
        message: `Service ${service.name} cannot realize probe listener ${endpoint.port}/${endpoint.transport}: ${reason}.`,
        remediation:
          "Declare the listener on a managed network with a non-loopback service name, or author a custom healthcheck for this topology.",
        issues: [],
      }),
    );
  }
  return Result.succeed({ host, port: endpoint.port, transport: endpoint.transport, network });
};
