import { expect, test } from "bun:test";
import { HOST_PROXY_SESSION_LABEL } from "@lando/container-runtime/labels";
import { PortablePath, type ServicePlan, fileSyncVolumeName } from "@lando/sdk/schema";
import {
  HOST_PROXY_CONTAINER_LANDO,
  HOST_PROXY_MOUNT_TARGETS,
} from "../../src/subsystems/host-proxy/transport-feature.ts";
import { plan, runInfo, service } from "./info-storage-fixture.ts";

test("omits runtime host-proxy binds when the applied plan has stripped the overlay", async () => {
  // Given: persisted mounts and environment are empty; inspection retains the session label.
  const internalMounts = [...HOST_PROXY_MOUNT_TARGETS].map((target) =>
    Object.freeze({ type: "bind" as const, source: `/host/integration${target}`, target, readOnly: true }),
  );
  const userMount = Object.freeze({ type: "volume" as const, source: "anonymous-data", target: "/data" });
  const mounts = Object.freeze({
    status: "present" as const,
    mounts: Object.freeze([...internalMounts, userMount]),
  });
  const labels = Object.freeze({ [HOST_PROXY_SESSION_LABEL]: "session-hash" });

  // When
  const { row, calls } = await runInfo(service, mounts, labels);

  // Then: only the user-facing projection changes, using the existing inspection.
  expect(row?.mounts).toEqual([
    { ...userMount, origin: "runtime", observation: "present", lifetime: "unknown" },
  ]);
  expect(calls).toEqual(["select", "inspect:web"]);
  expect(mounts.mounts).toEqual([...internalMounts, userMount]);
  expect(labels).toEqual({ [HOST_PROXY_SESSION_LABEL]: "session-hash" });
});

test.each([...HOST_PROXY_MOUNT_TARGETS])("retains an unmarked authored user bind at %s", async (target) => {
  // Given
  const mount = { type: "bind" as const, source: "/host/user-file", target, readOnly: true };
  const selected: ServicePlan = {
    ...service,
    mounts: [{ ...mount, target: PortablePath.make(target), realization: "passthrough" }],
  };

  // When
  const { row } = await runInfo(selected, { status: "present", mounts: [mount] }, {});

  // Then
  expect(row?.mounts).toEqual([
    { ...mount, origin: "planned", observation: "present", lifetime: "retained" },
  ]);
});

test("matches an accelerated user bind by mountKey after an internal integration mount", async () => {
  // Given: host-proxy integration is stripped; the user's accelerated bind is keyed independently.
  const internalMount = {
    type: "bind" as const,
    source: "/host/helper",
    target: PortablePath.make(HOST_PROXY_CONTAINER_LANDO),
    readOnly: true,
    realization: "passthrough" as const,
  };
  const selected: ServicePlan = {
    ...service,
    environment: { LANDO_HOST_PROXY_SESSION: "session" },
    mounts: [
      internalMount,
      {
        type: "bind",
        source: "/host/user-code",
        target: PortablePath.make("/workspace"),
        readOnly: false,
        realization: "accelerated",
        mountKey: "mount-workspace",
      },
    ],
  };
  const source = fileSyncVolumeName(plan.name, String(service.name), "mount-workspace");

  // When
  const { row } = await runInfo(
    selected,
    {
      status: "present",
      mounts: [internalMount, { type: "volume", source, target: "/workspace", readOnly: false }],
    },
    { [HOST_PROXY_SESSION_LABEL]: "session-hash" },
  );

  // Then: one retained host-source row, with neither internal nor backing-volume rows.
  expect(row?.mounts).toEqual([
    {
      type: "bind",
      source: "/host/user-code",
      target: "/workspace",
      readOnly: false,
      origin: "planned",
      observation: "present",
      lifetime: "retained",
    },
  ]);
});
