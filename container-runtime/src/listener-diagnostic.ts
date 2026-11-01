import { type ListenerObservation, type ServicePlan, groupLogicalEndpoints } from "@lando/sdk/schema";

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
        action: `Make ${listener.service} listen on ${listener.port}${ports.length === 1 && portOption ? `, or set \`port: ${other}\` if that is the port it uses` : ""}.`,
      };
    }
    case "loopback-only":
      return {
        finding: `only loopback TCP bindings observed on ${listener.port}, so other services can't reach it`,
        action: "Bind it to all interfaces (0.0.0.0) instead of loopback.",
      };
    case "listening":
      return {
        finding: `TCP ${listener.port} is bound, but readiness still failed`,
        action: "Check the readiness command; its last output is under lastStatus.",
      };
  }
};
