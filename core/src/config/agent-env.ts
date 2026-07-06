/**
 * Host agent-context env forwarding primitive (spec §6.9.1).
 *
 * Pure, Effect-free: the single source of truth for the built-in agent-context
 * env allowlist, the presence-gated resolver the exec surfaces use to forward
 * host agent markers into per-invocation exec requests, and the in-container
 * shim env filter (§10.10.3) that the agent-context names are appended to so a
 * `runLando` re-entry preserves the same markers.
 *
 * Forwarding is per-invocation: the resolver reads a caller-supplied host env
 * snapshot each call and never caches. Forwarded markers are always the lowest
 * precedence layer — explicit service/task/exec-request env wins.
 */

/**
 * The built-in agent-context allowlist (spec §6.9.1). Exact names, never
 * patterns; the default set is boolean/identity markers, not credentials.
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
 * In-container shim env-filter allowlist (spec §10.10.3). The shim forwards a
 * small set of env back to the host on a `runLando` re-entry; the agent-context
 * allowlist is appended (§6.9.1 host-proxy symmetry).
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
