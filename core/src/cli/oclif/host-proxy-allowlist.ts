import { HostProxyAllowlistConflictError } from "@lando/sdk/errors";

/**
 * Lifecycle and package-manager commands that MUST NOT ride the host-proxy
 * `runLando` channel (§10.10). A container asking the host to run these would
 * let a service tear down / restart the app or write to the host user's package
 * caches. A command in this set that sets `hostProxyAllowed: true` is rejected
 * at registration with `HostProxyAllowlistConflictError`.
 */
export const HOST_PROXY_ALLOWLIST_FORBIDDEN_IDS: ReadonlyArray<string> = [
  "app:start",
  "app:stop",
  "app:restart",
  "app:rebuild",
  "app:destroy",
  "apps:poweroff",
  "meta:bun",
  "meta:x",
];

const FORBIDDEN_ID_SET = new Set(HOST_PROXY_ALLOWLIST_FORBIDDEN_IDS);

export const isHostProxyAllowlistForbidden = (id: string): boolean => FORBIDDEN_ID_SET.has(id);

interface HostProxyAllowlistSpecView {
  readonly id: string;
  readonly hostProxyAllowed?: boolean;
}

export const assertHostProxyAllowlistSafe = (spec: HostProxyAllowlistSpecView): void => {
  if (spec.hostProxyAllowed === true && isHostProxyAllowlistForbidden(spec.id)) {
    throw new HostProxyAllowlistConflictError({
      message: `Command ${spec.id} is a lifecycle/package-manager surface and must not set hostProxyAllowed: true.`,
      commandId: spec.id,
      remediation:
        "Remove `hostProxyAllowed: true` from this command. Lifecycle and package-manager commands must never be reachable through the container→host runLando channel.",
    });
  }
};

export const computeHostProxyRunLandoAllowlist = (
  specs: ReadonlyArray<HostProxyAllowlistSpecView>,
): ReadonlyArray<string> => {
  const ids = new Set<string>();
  for (const spec of specs) {
    if (spec.hostProxyAllowed !== true) continue;
    assertHostProxyAllowlistSafe(spec);
    ids.add(spec.id);
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
};
