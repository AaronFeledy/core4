import type { PluginDoctorCheckContribution, PluginDoctorReport } from "@lando/sdk/plugins";
import { Effect, Result } from "effect";

import { type DockerEndpointSource, resolveDockerHost } from "./docker-endpoint.ts";

const sourceContext = (source: DockerEndpointSource): Record<string, string> =>
  source.kind === "context" ? { source: "context", contextName: source.name } : { source: source.kind };

const sourceLabel = (source: DockerEndpointSource): string =>
  source.kind === "context" ? `Docker context ${source.name}` : source.kind;

const endpointReport = (input: Parameters<PluginDoctorCheckContribution["run"]>[0]): PluginDoctorReport =>
  Result.match(resolveDockerHost({ platform: input.platform, env: input.env }), {
    onSuccess: ({ host, source }) => ({
      name: "docker-endpoint",
      status: "pass",
      severity: "info",
      runtimeStatus: `${host} (${sourceLabel(source)})`,
      context: { endpoint: host, ...sourceContext(source) },
      solutions: [],
    }),
    onFailure: (error) => ({
      name: "docker-endpoint",
      status: "fail",
      severity: "error",
      runtimeStatus: error.message,
      context: { source: "context", contextName: error.contextName, reason: error.reason },
      solutions: [{ kind: "manual", description: error.remediation }],
    }),
  });

/** Reports which Docker endpoint the docker provider resolves and why. */
export const dockerEndpointCheck: PluginDoctorCheckContribution = {
  id: "docker-endpoint",
  run: Effect.fn("DockerEndpointCheck.run")((input) =>
    Effect.sync(() => (input.providerId === "docker" ? [endpointReport(input)] : [])),
  ),
};
