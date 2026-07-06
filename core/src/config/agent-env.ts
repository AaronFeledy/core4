/**
 * Host agent-context env forwarding primitive.
 *
 * Pure, Effect-free: the single source of truth for the built-in agent-context
 * env allowlist, the presence-gated resolver the exec surfaces use to forward
 * host agent markers into per-invocation exec requests, and the in-container
 * shim env filter that appends the agent-context names so a `runLando`
 * re-entry preserves the same markers.
 *
 * Forwarding is per-invocation: the resolver reads a caller-supplied host env
 * snapshot each call and never caches. Forwarded markers are always the lowest
 * precedence layer — explicit service/task/exec-request env wins.
 */

/**
 * Built-in agent-context allowlist. Exact names, never patterns; the default
 * set is boolean/identity markers, not credentials.
 */
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

/**
 * Host env var that disables agent-context forwarding for a single invocation
 * when set to `"0"`, without mutating persisted config.
 */
export const AGENT_ENV_DISABLE_ENV_VAR = "LANDO_AGENT_ENV";

const EXACT_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Resolved agent-context forwarding policy: the global master switch, the
 * additional/suppressed names, and whether the resolved app opted out.
 */
export interface AgentEnvPolicy {
  readonly enabled?: boolean;
  readonly allow?: ReadonlyArray<string>;
  readonly deny?: ReadonlyArray<string>;
  readonly appOptOut?: boolean;
}

/** Whether `name` is an exact POSIX env-var name (never a wildcard/pattern). */
export const isExactAgentEnvName = (name: string): boolean => EXACT_ENV_NAME_PATTERN.test(name);

/** The offending names that are wildcards/patterns rather than exact names. */
export const findAgentEnvPatternNames = (names: ReadonlyArray<string>): ReadonlyArray<string> =>
  names.filter((name) => !isExactAgentEnvName(name));

/**
 * Forwarding is off when the global master switch is off, the app opted out, or
 * the per-invocation `LANDO_AGENT_ENV=0` switch is set.
 */
export const isAgentEnvForwardingDisabled = (policy: AgentEnvPolicy, hostEnv: HostEnv): boolean =>
  policy.enabled === false || policy.appOptOut === true || hostEnv[AGENT_ENV_DISABLE_ENV_VAR] === "0";

/**
 * The resolved forwarding allowlist: built-ins + `allow` − `deny`, or empty when
 * forwarding is disabled. Wildcard `allow` entries are dropped defensively; they
 * are rejected up front at config validation with `AgentEnvPatternError`.
 */
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

/**
 * Presence-gated resolution: returns the allowlisted names that are set in the
 * host env (value is not `undefined`). Unset names inject nothing — no
 * empty-string vars. A set-but-empty value is forwarded because it is present.
 */
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

/**
 * Merge the resolved agent-context markers as the lowest-precedence env layer
 * beneath the caller's explicit env (service declaration, tooling task, or exec
 * request). Explicit env always overrides a forwarded value. Returns `undefined`
 * when the merged result is empty so callers can omit the env field entirely.
 */
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

/**
 * In-container shim env-filter allowlist. The shim forwards a small set of env
 * back to the host on a `runLando` re-entry; the agent-context allowlist is
 * appended so host-proxy re-entry keeps the same markers.
 */
export const HOST_PROXY_ENV_PREFIXES: ReadonlyArray<string> = ["LANDO_", "LC_"];
export const HOST_PROXY_ENV_NAMES: ReadonlyArray<string> = ["LANG", "TERM"];

/**
 * Whether `name` is forwarded by the in-container shim env filter: a shim prefix
 * (`LANDO_`, `LC_`), a shim exact name (`LANG`, `TERM`), or an appended
 * agent-context marker.
 */
export const isHostProxyForwardedEnvName = (
  name: string,
  allowlist: ReadonlyArray<string> = AGENT_CONTEXT_ENV_ALLOWLIST,
): boolean =>
  HOST_PROXY_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
  HOST_PROXY_ENV_NAMES.includes(name) ||
  allowlist.includes(name);

/**
 * Filter a container env down to the shim forward allowlist so container-leaked
 * env never poisons the host program, while agent-context markers survive.
 * Unset values are skipped.
 */
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
