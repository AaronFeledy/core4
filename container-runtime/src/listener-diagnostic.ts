import {
  type ListenerObservation,
  type ServicePlan,
  formatListenerAuthority,
  groupLogicalEndpoints,
} from "@lando/sdk/schema";

/** What the listener's owner must configure, from the service type's structured authority. */
export const listenerAuthorityAction = (service: ServicePlan | undefined): string | undefined =>
  service?.listenerAuthority === undefined ? undefined : formatListenerAuthority(service.listenerAuthority);

const withAuthority = (action: string, service: ServicePlan, port: number): string => {
  const authority = service.listenerAuthority;
  return authority === undefined || authority.port !== port
    ? action
    : `${action} ${formatListenerAuthority(authority)}`;
};

export const listenerDiagnostic = (listener: ListenerObservation, service: ServicePlan) => {
  const ports = [...new Set(listener.listening.map((binding) => binding.port))];
  switch (listener.state) {
    case "not-listening": {
      const [other] = ports;
      const primary = groupLogicalEndpoints(service.endpoints).filter((endpoint) => endpoint.primary);
      const portOption =
        service.type !== "compose" &&
        primary.length === 1 &&
        primary[0]?.transport === "tcp" &&
        primary[0]?.port === listener.port;
      return {
        finding: `no TCP listener observed on ${listener.port}; observed ports: ${ports.length === 0 ? "none" : ports.join(", ")}`,
        action: withAuthority(
          `Make ${listener.service} listen on ${listener.port}${ports.length === 1 && portOption ? `, or set \`port: ${other}\` if that is the port it uses` : ""}.`,
          service,
          listener.port,
        ),
      };
    }
    case "loopback-only":
      return {
        finding: `only loopback TCP bindings observed on ${listener.port}, so other services can't reach it`,
        action: withAuthority(
          "Bind it to all interfaces (0.0.0.0) instead of loopback.",
          service,
          listener.port,
        ),
      };
    case "listening":
      return {
        finding: `TCP ${listener.port} is bound, but readiness still failed`,
        action: "Check the readiness command; its last output is under lastStatus.",
      };
  }
};
