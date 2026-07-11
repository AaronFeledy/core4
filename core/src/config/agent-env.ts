import { isHostProxyRunLandoEnvName } from "../subsystems/host-proxy/transport-feature.ts";

export const AGENT_CONTEXT_ENV_ALLOWLIST: ReadonlyArray<string> = [
  "CLAUDECODE",
  "CLAUDE_CODE",
  "CURSOR_AGENT",
  "OPENCODE",
  "COPILOT_CLI",
  "GEMINI_CLI",
  "AGENT",
  "CI",
];

export type HostEnv = Record<string, string | undefined>;

export const AGENT_ENV_DISABLE_ENV_VAR = "LANDO_AGENT_ENV";

const EXACT_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface AgentEnvPolicy {
  readonly enabled?: boolean;
  readonly allow?: ReadonlyArray<string>;
  readonly deny?: ReadonlyArray<string>;
  readonly appOptOut?: boolean;
}

export const isExactAgentEnvName = (name: string): boolean => EXACT_ENV_NAME_PATTERN.test(name);

export const findAgentEnvPatternNames = (names: ReadonlyArray<string>): ReadonlyArray<string> =>
  names.filter((name) => !isExactAgentEnvName(name));

export const isAgentEnvForwardingDisabled = (policy: AgentEnvPolicy, hostEnv: HostEnv): boolean =>
  policy.enabled === false || policy.appOptOut === true || hostEnv[AGENT_ENV_DISABLE_ENV_VAR] === "0";

export const resolveAgentEnvAllowlist = (policy: AgentEnvPolicy, hostEnv: HostEnv): ReadonlyArray<string> => {
  if (isAgentEnvForwardingDisabled(policy, hostEnv)) return [];
  const names = new Set<string>(AGENT_CONTEXT_ENV_ALLOWLIST);
  for (const name of policy.allow ?? []) if (isExactAgentEnvName(name)) names.add(name);
  for (const name of policy.deny ?? []) names.delete(name);
  return [...names];
};

interface AgentContextEnvMergeOptions {
  readonly allowlist?: ReadonlyArray<string>;
  readonly lowerThanEnv?: Readonly<Record<string, string>>;
}

export const resolveAgentContextEnv = (
  hostEnv: HostEnv,
  allowlist: ReadonlyArray<string> = AGENT_CONTEXT_ENV_ALLOWLIST,
): Record<string, string> => {
  const resolved: Record<string, string> = {};
  for (const name of allowlist) {
    const value = hostEnv[name];
    if (value !== undefined) resolved[name] = value;
  }
  return resolved;
};

export const withAgentContextEnv = (
  explicitEnv: Readonly<Record<string, string>> | undefined,
  hostEnv: HostEnv,
  options: AgentContextEnvMergeOptions = {},
): Record<string, string> | undefined => {
  const forwarded = resolveAgentContextEnv(hostEnv, options.allowlist ?? AGENT_CONTEXT_ENV_ALLOWLIST);
  for (const name of Object.keys(options.lowerThanEnv ?? {})) delete forwarded[name];
  const merged = { ...forwarded, ...(explicitEnv ?? {}) };
  return Object.keys(merged).length === 0 ? undefined : merged;
};

export const HOST_PROXY_ENV_PREFIXES: ReadonlyArray<string> = ["LANDO_", "LC_"];
export const HOST_PROXY_ENV_NAMES: ReadonlyArray<string> = ["LANG", "TERM"];

export const isHostProxyForwardedEnvName = (
  name: string,
  allowlist: ReadonlyArray<string> = AGENT_CONTEXT_ENV_ALLOWLIST,
): boolean =>
  !isHostProxyRunLandoEnvName(name) &&
  (HOST_PROXY_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
    HOST_PROXY_ENV_NAMES.includes(name) ||
    allowlist.includes(name));

export const filterHostProxyEnv = (
  env: HostEnv,
  allowlist: ReadonlyArray<string> = AGENT_CONTEXT_ENV_ALLOWLIST,
): Record<string, string> => {
  const filtered: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && isHostProxyForwardedEnvName(name, allowlist)) {
      filtered[name] = value;
    }
  }
  return filtered;
};
