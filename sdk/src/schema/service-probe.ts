import { Result, Schema } from "effect";
import { HealthcheckTargetUnsupportedError } from "../errors/healthcheck.ts";
import { LandofileValidationError } from "../errors/landofile.ts";
import {
  type AppPlan,
  type ServicePlan,
  landoAppNetworkName,
  landoServiceNetworkAliases,
  landoSharedNetworkName,
} from "./app-plan.ts";
import type { HealthcheckInput } from "./compose-healthcheck.ts";
import { logicalEndpointIdentity } from "./endpoint-selection.ts";
import type { EndpointRef } from "./endpoint.ts";
import type { HealthcheckPlan } from "./healthcheck-plan.ts";
import { ServiceConfig } from "./landofile.ts";
import type { ServiceName } from "./primitives.ts";

const decodeHostAliases = Schema.decodeUnknownResult(
  Schema.Struct({ extra_hosts: ServiceConfig.fields.extra_hosts }),
);

/** Startup and dependency readiness share exactly one defaulting rule. */
export const effectiveReadiness = (service: Pick<ServicePlan, "readiness" | "healthcheck">) =>
  service.readiness ?? service.healthcheck;

export const probeTargetError = (
  probe: HealthcheckPlan,
  service: ServiceName,
  role: "healthcheck" | "readiness",
): HealthcheckTargetUnsupportedError | undefined => {
  const nativeUnsupported =
    role === "healthcheck" && (probe.executionTarget === "host" || probe.user !== undefined);
  const hostUnsupported =
    probe.executionTarget === "host" &&
    (probe.user !== undefined ||
      probe.target !== undefined ||
      (probe.kind !== "none" && (probe.kind !== "command" || probe.command === undefined)));
  if (!nativeUnsupported && !hostUnsupported) return undefined;
  return new HealthcheckTargetUnsupportedError({
    service: String(service),
    target: probe.executionTarget ?? "service",
    message: nativeUnsupported
      ? "Native healthcheck cannot select a host target or an explicit user."
      : "Host readiness requires its own command without a container user or listener.",
    remediation:
      "Use readiness for host execution or an explicit container user. Host readiness requires its own command, application root, and host runner, with no user or listener target.",
  });
};

export const authoredProbeTargetError = (
  authored: HealthcheckInput,
  service: ServiceName,
  role: "healthcheck" | "readiness",
) => {
  if (authored === false) return undefined;
  const { target, ...probe } = authored;
  return probeTargetError(
    {
      ...probe,
      kind: probe.kind ?? "command",
      intervalSeconds: probe.intervalSeconds ?? 10,
      timeoutSeconds: probe.timeoutSeconds ?? 5,
      retries: probe.retries ?? 5,
      ...(target === undefined ? {} : { executionTarget: target }),
    },
    service,
    role,
  );
};

/**
 * Resolve a declared listener on managed DNS, never an interface address or loopback.
 *
 * `requireDeclared` keeps authoring honest about which listeners exist. A contributed
 * probe relaxes it: an `endpoints:` list replaces exposure and routing declarations, so a
 * service the author hid still listens on its own port, and health must keep dialling it.
 */
export const serviceListenerTarget = (
  plan: Pick<AppPlan, "slug" | "networking">,
  service: Pick<ServicePlan, "name" | "endpoints"> & Partial<Pick<ServicePlan, "hostAliases" | "extensions">>,
  endpoint: EndpointRef,
  options: { readonly requireDeclared?: boolean } = {},
) => {
  const privateNetwork = landoAppNetworkName(plan);
  const network = privateNetwork ?? landoSharedNetworkName(plan);
  const host =
    privateNetwork === undefined ? landoServiceNetworkAliases(plan, service)[0] : String(service.name);
  const declared = service.endpoints.some(
    (candidate) => logicalEndpointIdentity(candidate) === logicalEndpointIdentity(endpoint),
  );
  const refuse = (reason: string) =>
    Result.fail(
      new LandofileValidationError({
        file: ".lando.yml",
        message: `Service ${service.name} cannot realize probe listener ${endpoint.port}/${endpoint.transport}: ${reason}.`,
        remediation:
          "Declare the listener on a managed network with a non-loopback service name, or author a custom healthcheck for this topology.",
        issues: [],
      }),
    );
  if (!declared && options.requireDeclared !== false) return refuse("the listener is not declared");
  if (network === undefined || host === undefined) return refuse("no managed network realizes the listener");
  if (
    /^(?:localhost6?(?:\.localdomain6?)?\.?|ip6-localhost\.?|ip6-loopback\.?|::1|(?:0x[\da-f]+|\d+)(?:\.(?:0x[\da-f]+|\d+)){0,3})$/iu.test(
      host,
    )
  )
    return refuse("the hostname is reserved or numeric, not managed service DNS");
  const aliases = decodeHostAliases(service.extensions?.compose ?? {});
  if (Result.isFailure(aliases)) return refuse("Compose host aliases cannot be realized");
  const hostname = host.toLowerCase();
  const overridden =
    service.hostAliases?.some((alias) => alias.hostname.toLowerCase() === hostname) === true ||
    Object.entries(aliases.success.extra_hosts ?? {}).some(
      ([alias, addresses]) =>
        alias.toLowerCase() === hostname && (typeof addresses === "string" || addresses.length > 0),
    );
  if (overridden) return refuse("a host alias overrides managed service DNS");
  return Result.succeed({ host, port: endpoint.port, transport: endpoint.transport, network });
};
