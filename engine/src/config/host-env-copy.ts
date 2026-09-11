export type HostEnv = Record<string, string | undefined>;

/**
 * Copy allowlisted host env names that are present (including empty string).
 * Unset names are omitted. Callers supply their own allowlist so jobs stay
 * separate: agent-context, host-proxy, and interactive TTY capability
 * detection must not share one fingerprint list.
 */
export const copyPresentHostEnv = (
  hostEnv: HostEnv,
  allowlist: ReadonlyArray<string>,
): Record<string, string> => {
  const resolved: Record<string, string> = {};
  for (const name of allowlist) {
    const value = hostEnv[name];
    if (value !== undefined) resolved[name] = value;
  }
  return resolved;
};
