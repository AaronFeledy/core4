import type { PluginDoctorCheckContribution, PluginDoctorReport } from "@lando/sdk/plugins";
import { Effect } from "effect";

import {
  type DockerContextFileReader,
  dockerHostSourceLabel,
  readDockerContextFile,
  resolveDockerHostDetails,
} from "./docker-context.ts";

const endpointReports = (
  input: Parameters<PluginDoctorCheckContribution["run"]>[0],
  readFile: DockerContextFileReader,
): ReadonlyArray<PluginDoctorReport> => {
  if (input.providerId !== "docker") return [];

  const resolved = resolveDockerHostDetails({
    platform: input.platform,
    env: input.env,
    readFile,
  });

  if (!resolved.ok) {
    const { error } = resolved;
    return [
      {
        name: "docker-endpoint",
        status: "fail",
        severity: "error",
        runtimeStatus: error.message,
        context: {
          contextName: error.contextName,
          reason: error.reason,
        },
        solutions: [
          {
            kind: "manual",
            description: error.remediation,
          },
        ],
      } satisfies PluginDoctorReport,
    ];
  }

  const source = dockerHostSourceLabel(resolved.source);
  return [
    {
      name: "docker-endpoint",
      status: "pass",
      severity: "info",
      runtimeStatus: `${resolved.host} (${source})`,
      context: {
        endpoint: resolved.host,
        source,
      },
      solutions: [],
    } satisfies PluginDoctorReport,
  ];
};

export const makeDockerEndpointCheck = (
  readFile: DockerContextFileReader = readDockerContextFile,
): PluginDoctorCheckContribution => ({
  id: "docker-endpoint",
  run: Effect.fn("DockerEndpointCheck.run")((input) => Effect.succeed(endpointReports(input, readFile))),
});
