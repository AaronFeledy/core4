import { isHostProxyRunLandoEnvName } from "../subsystems/host-proxy/session-env.ts";
import { type HostEnv, copyPresentHostEnv } from "./host-env-copy.ts";

export type { HostEnv };

// Must stay import-light (no Effect): the compiled host-proxy shim bundle imports this module.

// Presence markers for agent detectors; no tokens, no session/path dumps.
// Deliberate exclusions (not a parity chase): path-valued names
// (GROK_PLUGIN_ROOT, GROK_PLUGIN_DATA, KIMI_PLUGIN_ROOT, JUNIE_DATA,
// JUNIE_SHIM_PATH, KIRO_AGENT_PATH) leak host paths; ids
// (AMP_CURRENT_THREAD_ID, CODEX_THREAD_ID, MATTERHORN_SESSION_ID, REPL_ID)
// leak session ids; CODEX_SANDBOX_NETWORK_DISABLED changes software
// behavior; ANTIGRAVITY_CLI_ALIAS is an alias and ANTIGRAVITY_AGENT already
// covers detection; COPILOT_ALLOW_ALL would grant every tool permission;
// COPILOT_GITHUB_TOKEN is a credential; COPILOT_MODEL is a setting.
// Never forge AI_AGENT.
export const AGENT_CONTEXT_ENV_ALLOWLIST: ReadonlyArray<string> = [
  "CLAUDECODE",
  "CLAUDE_CODE",
  "CLAUDE_CODE_IS_COWORK",
  "CURSOR_AGENT",
  "OPENCODE",
  "OPENCODE_CLIENT",
  "COPILOT_CLI",
  "GEMINI_CLI",
  "CODEX_SANDBOX",
  "CODEX_CI",
  "AUGMENT_AGENT",
  "ANTIGRAVITY_AGENT",
  "PI_CODING_AGENT",
  "CLINE_ACTIVE",
  "GOOSE_TERMINAL",
  "OPENCLAW_SHELL",
  "GROK_AGENT",
  "AI_AGENT",
  "AGENT",
  "CI",
];

export const AGENT_ENV_DISABLE_ENV_VAR = "LANDO_AGENT_ENV";

const AGENT_ENV_VALUE_MUST_BE_ONE: ReadonlySet<string> = new Set(["GROK_AGENT"]);

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

export const isForwardableAgentEnvValue = (name: string, value: string): boolean =>
  !AGENT_ENV_VALUE_MUST_BE_ONE.has(name) || value === "1";

const applyAgentEnvValueGuards = (env: Record<string, string>): Record<string, string> => {
  const guarded: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (isForwardableAgentEnvValue(name, value)) guarded[name] = value;
  }
  return guarded;
};

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
): Record<string, string> => applyAgentEnvValueGuards(copyPresentHostEnv(hostEnv, allowlist));

export const resolveForwardedAgentEnvNames = (
  policy: AgentEnvPolicy,
  hostEnv: HostEnv,
): ReadonlyArray<string> =>
  Object.keys(resolveAgentContextEnv(hostEnv, resolveAgentEnvAllowlist(policy, hostEnv)));

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
    if (
      value !== undefined &&
      isHostProxyForwardedEnvName(name, allowlist) &&
      isForwardableAgentEnvValue(name, value)
    ) {
      filtered[name] = value;
    }
  }
  return filtered;
};
