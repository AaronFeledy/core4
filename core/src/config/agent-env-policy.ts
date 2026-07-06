import { Effect } from "effect";

import type { ConfigError } from "@lando/sdk/errors";
import { ConfigService } from "@lando/sdk/services";

import {
  type AgentEnvPolicy,
  type HostEnv,
  isAgentEnvForwardingDisabled,
  resolveAgentEnvAllowlist,
} from "./agent-env.ts";

const readPolicy = (
  landofileAgentEnv: boolean | undefined,
): Effect.Effect<AgentEnvPolicy, ConfigError, ConfigService> =>
  Effect.gen(function* () {
    const configService = yield* ConfigService;
    const agentEnv = yield* configService.get("agentEnv");
    return {
      ...(agentEnv?.enabled === undefined ? {} : { enabled: agentEnv.enabled }),
      ...(agentEnv?.allow === undefined ? {} : { allow: agentEnv.allow }),
      ...(agentEnv?.deny === undefined ? {} : { deny: agentEnv.deny }),
      appOptOut: landofileAgentEnv === false,
    };
  });

export const resolveAgentEnvForwardAllowlist = (
  landofileAgentEnv: boolean | undefined,
  hostEnv: HostEnv,
): Effect.Effect<ReadonlyArray<string>, ConfigError, ConfigService> =>
  readPolicy(landofileAgentEnv).pipe(Effect.map((policy) => resolveAgentEnvAllowlist(policy, hostEnv)));

export interface AgentEnvAudit {
  readonly enabled: boolean;
  readonly forwarded: ReadonlyArray<string>;
}

export const resolveAgentEnvAudit = (
  landofileAgentEnv: boolean | undefined,
  hostEnv: HostEnv,
): Effect.Effect<AgentEnvAudit, ConfigError, ConfigService> =>
  readPolicy(landofileAgentEnv).pipe(
    Effect.map((policy) => ({
      enabled: !isAgentEnvForwardingDisabled(policy, hostEnv),
      forwarded: resolveAgentEnvAllowlist(policy, hostEnv),
    })),
  );
