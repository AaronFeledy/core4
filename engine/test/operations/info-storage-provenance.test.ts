import { expect, test } from "bun:test";
import { PortablePath } from "@lando/sdk/schema";
import { runInfo, service } from "./info-storage-fixture.ts";

test("hides integration mounts without labels and preserves provenance at reserved targets", async () => {
  // Given planned mounts whose ownership does not depend on runtime labels.
  const mounts = [
    {
      type: "volume" as const,
      store: "vendor",
      target: PortablePath.make("/app/vendor"),
      readOnly: false,
      origin: "derived" as const,
    },
    {
      type: "volume" as const,
      store: "agent",
      target: PortablePath.make("/run/custom-agent"),
      readOnly: false,
      origin: "integration" as const,
    },
    {
      type: "volume" as const,
      store: "tool",
      target: PortablePath.make("/usr/local/bin/lando"),
      readOnly: true,
      origin: "authored" as const,
    },
    {
      type: "volume" as const,
      store: "data",
      target: PortablePath.make("/data"),
      readOnly: false,
      origin: "service" as const,
    },
  ];
  // When a legacy integration environment is also present.
  const { row } = await runInfo(
    { ...service, environment: { LANDO_HOST_PROXY_SESSION: "session" }, mounts },
    {
      status: "present",
      mounts: mounts.map((mount) => ({ type: mount.type, target: mount.target, source: mount.store })),
    },
  );
  // Then only user-facing mounts remain, each explaining its planned provenance.
  expect(row?.mounts?.map(({ target, provenance, origin }) => ({ target, provenance, origin }))).toEqual([
    { target: "/app/vendor", provenance: "derived", origin: "planned" },
    { target: "/usr/local/bin/lando", provenance: "authored", origin: "planned" },
    { target: "/data", provenance: "service", origin: "planned" },
  ]);
});
