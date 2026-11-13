import { COMMAND_REGISTRY_MANIFEST } from "../generated/command-registry-manifest";
import { HOST_PROXY_RUNLANDO_ALLOWLIST } from "../generated/host-proxy-allowlist";
import type { DoctorFinding, DoctorSolution } from "./doctor-contract";

interface HostProxyManifestCommand {
  readonly spec?: unknown;
}

export interface HostProxyAllowlistFreshness {
  readonly fresh: boolean;
  readonly missing: ReadonlyArray<string>;
  readonly unexpected: ReadonlyArray<string>;
}

export const hostProxyAllowlistFreshness = (
  allowlist: ReadonlyArray<string>,
  commands: Readonly<Record<string, HostProxyManifestCommand>>,
): HostProxyAllowlistFreshness => {
  const expected = Object.entries(commands)
    .filter(([, command]) => {
      const spec = command.spec;
      return (
        typeof spec === "object" &&
        spec !== null &&
        "hostProxyAllowed" in spec &&
        spec.hostProxyAllowed === true
      );
    })
    .map(([id]) => id)
    .sort();
  const actual = [...new Set(allowlist)].sort();
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((id) => !actualSet.has(id));
  const unexpected = actual.filter((id) => !expectedSet.has(id));
  const fresh =
    allowlist.length === expected.length && allowlist.every((id, index) => id === expected[index]);
  return { fresh, missing, unexpected };
};

export const currentHostProxyAllowlistFreshness = (): HostProxyAllowlistFreshness =>
  hostProxyAllowlistFreshness(HOST_PROXY_RUNLANDO_ALLOWLIST, COMMAND_REGISTRY_MANIFEST.commands);

const HOST_PROXY_ALLOWLIST_REMEDIATION: DoctorSolution = {
  kind: "manual",
  description: "The generated host-proxy command allowlist is stale. Regenerate it before shipping.",
  command: "bun run codegen:host-proxy-allowlist",
};

export const buildHostProxyAllowlistDoctorCheck = (
  freshness: HostProxyAllowlistFreshness,
): DoctorFinding | undefined =>
  freshness.fresh
    ? undefined
    : {
        name: "host-proxy-allowlist",
        status: "warn",
        severity: "warn",
        context: {
          freshness: "stale",
          missing: freshness.missing.join(",") || "none",
          unexpected: freshness.unexpected.join(",") || "none",
        },
        solutions: [HOST_PROXY_ALLOWLIST_REMEDIATION],
      };
