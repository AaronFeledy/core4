import { Effect } from "effect";

import type {
  PluginDoctorCheckContribution,
  PluginDoctorCheckInput,
  PluginDoctorReport,
} from "@lando/sdk/plugins";

import {
  SSH_AGENT_UPSTREAM_FALLBACK_WARNING,
  SSH_AGENT_UPSTREAM_WINDOWS_MESSAGE,
  SSH_AGENT_UPSTREAM_WINDOWS_REMEDIATION,
  authoredUpstreamFromEnv,
  resolveSshAgentUpstream,
} from "./upstream.ts";

const CHECK_ID = "ssh-agent-upstream" as const;

export const runSshAgentUpstreamDoctorCheck = (
  input: PluginDoctorCheckInput,
): Effect.Effect<ReadonlyArray<PluginDoctorReport>, never> =>
  Effect.sync(() => {
    const upstream = authoredUpstreamFromEnv(input.env);
    if (upstream === undefined) return [];

    const resolution = resolveSshAgentUpstream({
      upstream,
      sshAuthSock: input.env.SSH_AUTH_SOCK,
      platform: input.platform,
    });

    const context: Record<string, string> = {
      upstream,
      mode: resolution.kind,
    };
    if (resolution.kind === "upstream") context.upstreamSock = resolution.socketPath;
    if (resolution.kind === "fallback" || resolution.kind === "unsupported") {
      context.upstreamSock = input.env.SSH_AUTH_SOCK ?? "";
    }
    if (resolution.kind === "invalid") context.upstreamSock = resolution.requested;

    if (resolution.kind === "upstream") {
      return [
        {
          name: CHECK_ID,
          status: "pass",
          severity: "info",
          context,
          solutions: [],
        },
      ];
    }

    if (resolution.kind === "unsupported") {
      return [
        {
          name: CHECK_ID,
          status: "fail",
          severity: "error",
          context: {
            ...context,
            remediation: resolution.remediation,
          },
          solutions: [
            {
              kind: "manual",
              description: `${resolution.message} ${resolution.remediation}`,
            },
          ],
        },
      ];
    }

    if (resolution.kind === "invalid") {
      return [
        {
          name: CHECK_ID,
          status: "fail",
          severity: "error",
          context,
          solutions: [
            {
              kind: "manual",
              description: resolution.message,
            },
          ],
        },
      ];
    }

    return [
      {
        name: CHECK_ID,
        status: "warn",
        severity: "warn",
        context: {
          ...context,
          fallback: "file-load",
        },
        solutions: [
          {
            kind: "manual",
            description:
              resolution.kind === "fallback" ? resolution.warning : SSH_AGENT_UPSTREAM_FALLBACK_WARNING,
          },
        ],
      },
    ];
  });

export const sshAgentUpstreamDoctorCheck: PluginDoctorCheckContribution = {
  id: CHECK_ID,
  run: runSshAgentUpstreamDoctorCheck,
};

export const sshAgentUpstreamDoctorMessages = {
  windows: SSH_AGENT_UPSTREAM_WINDOWS_MESSAGE,
  windowsRemediation: SSH_AGENT_UPSTREAM_WINDOWS_REMEDIATION,
  fallback: SSH_AGENT_UPSTREAM_FALLBACK_WARNING,
};
