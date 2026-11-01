import { expect, test } from "bun:test";
import { type AppPlan, type MountPlan, PortablePath } from "@lando/sdk/schema";
import { stripGpgAgentOverlay } from "../../src/subsystems/gpg-agent/overlay.ts";
import { stripHostProxyRunLando } from "../../src/subsystems/host-proxy/transport-feature.ts";
import { stripSshAgentOverlay } from "../../src/subsystems/ssh-agent/overlay.ts";
import { plan, service } from "../operations/info-storage-fixture.ts";

const subsystems: readonly {
  readonly name: string;
  readonly targets: readonly string[];
  readonly strip: (plan: AppPlan) => AppPlan;
}[] = [
  { name: "ssh", targets: ["/run/lando/ssh-agent", "/etc/ssh/ssh_known_hosts"], strip: stripSshAgentOverlay },
  {
    name: "gpg",
    targets: ["/run/lando/gpg-agent", "/run/lando/gpg-agent-keys"],
    strip: stripGpgAgentOverlay,
  },
  {
    name: "host-proxy",
    targets: [
      "/run/lando/host-proxy.sock",
      "/usr/local/bin/lando",
      "/usr/local/bin/open",
      "/usr/local/bin/xdg-open",
    ],
    strip: stripHostProxyRunLando,
  },
];

for (const subsystem of subsystems) {
  test.each([undefined, "integration", "authored", "service", "derived"] as const)(
    `${subsystem.name} strip respects mount origin %s`,
    (origin) => {
      // Given owned targets with explicit provenance, or legacy mounts without it.
      const mounts: MountPlan[] = subsystem.targets.map((target) => ({
        type: "bind",
        ...(origin === undefined ? {} : { origin }),
        source: "/host/source",
        target: PortablePath.make(target),
        readOnly: true,
        realization: "passthrough",
      }));
      const unrelated: MountPlan = {
        type: "volume",
        origin: "integration",
        store: "unrelated",
        target: PortablePath.make("/other-integration"),
        readOnly: false,
      };
      const input: AppPlan = {
        ...plan,
        services: { [service.name]: { ...service, mounts: [...mounts, unrelated] } },
      };
      // When this subsystem strips its own overlay.
      const result = subsystem.strip(input);
      // Then explicit planned mounts survive, and another integration remains untouched.
      expect(result.services[service.name]?.mounts).toEqual(
        origin === undefined || origin === "integration" ? [unrelated] : [...mounts, unrelated],
      );
    },
  );
}
