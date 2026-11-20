import {
  type AppPlan,
  type EndpointRef,
  type HealthcheckPlan,
  PortNumber,
  type ServicePlan,
  serviceListenerTarget,
} from "@lando/sdk/schema";
import { Result, Schema } from "effect";
import { CONTAINER_HELPER_PROBE_EXECUTABLE } from "./container-helper.ts";
import { ContainerPlanError } from "./container-plan-error.ts";

const isPort = Schema.is(PortNumber);

export const serviceProbeInputIssue = (
  probe: Pick<HealthcheckPlan, "kind" | "url" | "port" | "command" | "target">,
) => {
  switch (probe.kind) {
    case "none":
      return undefined;
    case "command":
      return probe.command === undefined
        ? { field: "command", message: "Supply a command or disable the probe with false." }
        : undefined;
    case "http":
      return probe.url !== undefined &&
        /^https?:\/\/[^/]/iu.test(probe.url) &&
        !/[\s\\]/u.test(probe.url) &&
        URL.canParse(probe.url)
        ? undefined
        : { field: "url", message: "Supply an absolute HTTP or HTTPS URL." };
    case "tcp":
      if (probe.target !== undefined)
        return probe.target.transport === "tcp"
          ? undefined
          : { field: "target", message: "Select a TCP listener target." };
      return isPort(probe.port)
        ? undefined
        : { field: "port", message: "Supply a TCP port from 1 to 65535 or a TCP listener target." };
  }
};

export const serviceProbeListener = (probe: HealthcheckPlan): EndpointRef | undefined =>
  probe.target ??
  (probe.kind === "tcp" && probe.port !== undefined
    ? { port: probe.port, transport: "tcp", names: [], primary: false }
    : undefined);

type ProbeService = Pick<ServicePlan, "name" | "endpoints"> &
  Partial<Pick<ServicePlan, "hostAliases" | "extensions">>;

export const compileServiceProbe = (
  probe: HealthcheckPlan,
  plan?: Pick<AppPlan, "slug" | "networking">,
  service?: ProbeService,
): readonly string[] | undefined => {
  if (probe.executionTarget === "host") return undefined;
  const issue = serviceProbeInputIssue(probe);
  if (issue !== undefined) throw new ContainerPlanError(issue.message);
  const resolveListener = (listener: EndpointRef) => {
    if (plan === undefined || service === undefined)
      throw new ContainerPlanError("Listener probes require their application and service plan.");
    // Exposure overrides must not hide a port the service is still listening on.
    const target = serviceListenerTarget(plan, service, listener, { requireDeclared: false });
    if (Result.isFailure(target)) throw new ContainerPlanError(target.failure.message);
    return target.success;
  };
  const timeout = String(probe.timeoutSeconds);
  switch (probe.kind) {
    case "none":
      return undefined;
    case "http":
      return probe.url === undefined
        ? undefined
        : [CONTAINER_HELPER_PROBE_EXECUTABLE, "probe-http", "--url", probe.url, "--timeout", timeout];
    case "tcp": {
      const listener = serviceProbeListener(probe);
      if (listener === undefined) return undefined;
      const { host, port } = resolveListener(listener);
      return [
        CONTAINER_HELPER_PROBE_EXECUTABLE,
        "probe-tcp",
        "--host",
        host,
        "--port",
        String(port),
        "--timeout",
        timeout,
      ];
    }
    case "command": {
      if (probe.command === undefined) return undefined;
      const command = typeof probe.command === "string" ? ["sh", "-c", probe.command] : [...probe.command];
      if (probe.target === undefined) return command;
      const { host, port } = resolveListener(probe.target);
      return ["env", `LANDO_PROBE_HOST=${host}`, `LANDO_PROBE_PORT=${port}`, ...command];
    }
  }
};
