import { expect, test } from "bun:test";
import { PortablePath } from "@lando/sdk/schema";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect } from "effect";
import { validateHostProxyOverlay } from "../../src/operations/start-host-proxy.ts";
import { validateGpgAgentOverlay } from "../../src/subsystems/gpg-agent/overlay.ts";
import { plan, web } from "./start-progress-topology-support.ts";

test("GPG preflight rejects its keyring target without acquiring a relay", () => {
  // Given authored ownership of the keyring target on an eligible service.
  const selected = {
    ...plan,
    services: {
      [web.name]: {
        ...web,
        extensions: { "@lando/core/gpg-agent": { forward: true } },
        mounts: [
          {
            type: "bind" as const,
            source: "/authored",
            target: PortablePath.make("/run/lando/gpg-agent-keys"),
            readOnly: true,
            realization: "passthrough" as const,
          },
        ],
      },
    },
  };
  // When only read-only overlay validation runs.
  const result = Effect.runSync(Effect.result(validateGpgAgentOverlay(selected)));
  // Then the same typed projection failure is available before lifecycle mutation.
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "GpgAgentTransportError", stage: "bridge" },
  });
});

for (const mode of ["active", "unreachable", "no-target", "ineligible", "windows-socket"] as const) {
  test(`host-proxy preflight preserves ${mode} target selection`, () => {
    // Given a reserved target collision and a provider's actual transport eligibility.
    const selected = {
      ...plan,
      services: {
        [web.name]: {
          ...web,
          extensions:
            mode === "ineligible"
              ? {}
              : { "@lando/core/service-features": { featureIds: ["lando.host-proxy"] } },
          mounts: [
            {
              type: "bind" as const,
              source: "/authored",
              target: PortablePath.make(
                mode === "windows-socket" ? "/run/lando/host-proxy.sock" : "/usr/local/bin/lando",
              ),
              readOnly: true,
              realization: "passthrough" as const,
            },
          ],
        },
      },
    };
    const capabilities = {
      ...TestRuntimeProvider.capabilities,
      hostReachability: mode === "unreachable" ? ("none" as const) : ("emulated" as const),
      hostProxy: {
        containerTargets: mode === "no-target" ? [] : [{ os: "linux" as const, arch: "x64" as const }],
        tcpHostGateway: "host.lando.internal",
      },
    };
    // When validation runs without a synthetic worker or session material.
    const result = Effect.runSync(
      Effect.result(
        validateHostProxyOverlay(selected, capabilities, mode === "windows-socket" ? "win32" : "linux"),
      ),
    );
    // Then only an active transport claiming the authored target is rejected.
    expect(result._tag).toBe(mode === "active" ? "Failure" : "Success");
    if (result._tag === "Failure") expect(result.failure._tag).toBe("HostProxyTransportUnavailableError");
  });
}
