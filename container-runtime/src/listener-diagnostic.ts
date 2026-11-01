import {
  type ListenerObservation,
  type ServicePlan,
  formatListenerAuthority,
  groupLogicalEndpoints,
} from "@lando/sdk/schema";

/** What the listener's owner must configure, from the service type's structured authority. */
export const listenerAuthorityAction = (service: ServicePlan | undefined): string | undefined =>
  service?.listenerAuthority === undefined ? undefined : formatListenerAuthority(service.listenerAuthority);

export const listenerDiagnostic = (
  listener: ListenerObservation,
  service: ServicePlan,
  context: "readiness" | "scan" = "readiness",
): { finding: string; action: string; authority?: string } => {
  const ports = [...new Set(listener.listening.map((binding) => binding.port))];
  const authority =
    service.listenerAuthority?.port === listener.port
      ? { authority: formatListenerAuthority(service.listenerAuthority) }
      : {};
  switch (listener.state) {
    case "not-listening": {
      const [other] = ports;
      const endpoints = groupLogicalEndpoints(service.endpoints);
      const primary = endpoints.filter((endpoint) => endpoint.primary);
      const portOption =
        service.type !== "compose" &&
        service.listenerAuthority?.port === listener.port &&
        primary.length === 1 &&
        primary[0]?.transport === "tcp" &&
        primary[0]?.port === listener.port &&
        !endpoints.some((endpoint) => !endpoint.primary && endpoint.port === other) &&
        listener.listening.some((binding) => binding.port === other && !isLoopbackAddress(binding.address));
      return {
        finding: `no TCP listener observed on ${listener.port}; observed ports: ${ports.length === 0 ? "none" : ports.join(", ")}`,
        action: `Make ${listener.service} listen on ${listener.port}${ports.length === 1 && portOption ? `, or set \`port: ${other}\` if that is the port it uses` : ""}.`,
        ...authority,
      };
    }
    case "loopback-only":
      return {
        finding: `only loopback TCP bindings observed on ${listener.port}, so other services can't reach it`,
        action: "Bind it to all interfaces (0.0.0.0) instead of loopback.",
        ...authority,
      };
    case "listening":
      if (context === "scan")
        return {
          finding: `TCP ${listener.port} has a non-loopback binding, but this endpoint remains unreachable`,
          action: "Check the network path and HTTP/TLS configuration for this endpoint.",
        };
      return {
        finding: `TCP ${listener.port} is bound, but readiness still failed`,
        action: "Check the readiness command; its last output is under lastStatus.",
      };
  }
};

const isLoopbackAddress = (address: string): boolean =>
  address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
