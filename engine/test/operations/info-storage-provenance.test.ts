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

test("matches a file-mode bind to the private copy the container binds", async () => {
  // Given a config grant planned as a file-mode bind and observed through its private copy.
  const mounts = [
    {
      type: "bind" as const,
      source: "/srv/app/config/php.ini",
      target: PortablePath.make("/etc/app.ini"),
      readOnly: true,
      createHostPath: false,
      realization: "passthrough" as const,
      fileMode: 0o440,
      origin: "authored" as const,
    },
  ];
  const { row } = await runInfo(
    { ...service, mounts },
    {
      status: "present",
      mounts: [
        {
          type: "bind",
          target: "/etc/app.ini",
          source: "/home/user/.local/share/lando/file-mode-mounts/abc-440/abc-440",
          readOnly: true,
        },
      ],
    },
  );
  // Then the one planned mount is present and no runtime duplicate appears.
  expect(row?.mounts).toEqual([
    {
      type: "bind",
      target: "/etc/app.ini",
      source: "/srv/app/config/php.ini",
      readOnly: true,
      origin: "planned",
      observation: "present",
      lifetime: "retained",
      provenance: "authored",
    },
  ]);
});
