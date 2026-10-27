import { expect, test } from "bun:test";
import {
  AGENT_SOCKET_CONTAINER_DIR,
  AbsolutePath,
  PortablePath,
  type ServicePlan,
  fileSyncVolumeName,
} from "@lando/sdk/schema";
import { appMount, plan, runInfo, service, withAppMount } from "./info-storage-fixture.ts";

test("exposes declared storage and full app mount with one selection and inspection", async () => {
  const selected = {
    ...service,
    mounts: [
      appMount,
      { type: "volume" as const, store: "database", target: PortablePath.make("/data"), readOnly: false },
      { type: "tmpfs" as const, target: PortablePath.make("/memory"), readOnly: false },
    ],
  };
  const { row, calls } = await runInfo(selected, {
    status: "present",
    mounts: [
      { type: "bind", target: "/app", source: "/host/app", readOnly: false },
      { type: "volume", target: "/data", source: "database", readOnly: false },
      { type: "tmpfs", target: "/memory", readOnly: false },
    ],
  });
  expect(calls).toEqual(["select", "inspect:web"]);
  expect(row?.appMount).toEqual(appMount);
  expect(row?.mounts).toEqual([
    {
      type: "bind",
      source: "/host/app",
      target: "/app",
      readOnly: false,
      origin: "planned",
      observation: "present",
      lifetime: "retained",
    },
    {
      type: "volume",
      source: "database",
      target: "/data",
      readOnly: false,
      origin: "planned",
      observation: "present",
      lifetime: "retained",
    },
    {
      type: "tmpfs",
      target: "/memory",
      readOnly: false,
      origin: "planned",
      observation: "present",
      lifetime: "container",
    },
  ]);
  expect(row?.connections).toEqual([]);
});

test.each(["a".repeat(64), "friendly-volume"])(
  "does not infer runtime volume lifetime from name %s",
  async (source) => {
    const { row } = await runInfo(service, {
      status: "present",
      mounts: [{ type: "volume", source, target: "/data" }],
    });
    expect(row?.mounts).toEqual([
      {
        type: "volume",
        source,
        target: "/data",
        origin: "runtime",
        observation: "present",
        lifetime: "unknown",
      },
    ]);
    expect(row?.appMount).toBeUndefined();
  },
);

test.each([
  undefined,
  { status: "unknown" as const },
  { status: "missing" as const },
  { status: "present" as const, mounts: [] },
])("distinguishes absent container and unavailable evidence: %j", async (mounts) => {
  const { row } = await runInfo(withAppMount(service), mounts);
  expect(row?.mounts?.[0]?.observation).toBe(
    mounts?.status === "missing" || mounts?.status === "present" ? "missing" : "unknown",
  );
});

test("keeps incompatible source at the same destination runtime-only", async () => {
  const { row } = await runInfo(
    {
      ...service,
      mounts: [{ type: "volume", store: "expected", target: PortablePath.make("/data"), readOnly: false }],
    },
    { status: "present", mounts: [{ type: "volume", source: "different", target: "/data", readOnly: true }] },
  );
  expect(row?.mounts).toEqual([
    {
      type: "volume",
      source: "expected",
      target: "/data",
      readOnly: false,
      origin: "planned",
      observation: "missing",
      lifetime: "retained",
    },
    {
      type: "volume",
      source: "different",
      target: "/data",
      readOnly: true,
      origin: "runtime",
      observation: "present",
      lifetime: "unknown",
    },
  ]);
});

test("recognizes accelerated application mounts without marking them missing", async () => {
  const source = fileSyncVolumeName(plan.name, String(service.name), "app-mount");
  const { row } = await runInfo(
    withAppMount(service, { ...appMount, realization: "accelerated", mountKey: "app-mount" }),
    { status: "present", mounts: [{ type: "volume", source, target: "/app", readOnly: false }] },
  );
  expect(row?.mounts).toEqual([
    {
      type: "bind",
      source: "/host/app",
      target: "/app",
      readOnly: false,
      origin: "planned",
      observation: "present",
      lifetime: "retained",
    },
  ]);
});

test("does not assert a missing Windows bind when the daemon exposes a mapped guest path", async () => {
  const { row } = await runInfo(
    withAppMount(service, { ...appMount, source: AbsolutePath.make("C:\\work\\app") }),
    { status: "present", mounts: [{ type: "bind", source: "/mnt/c/work/app", target: "/app" }] },
  );
  expect(row?.mounts?.[0]).toMatchObject({
    origin: "planned",
    observation: "unknown",
    source: "C:\\work\\app",
    lifetime: "retained",
  });
  expect(row?.mounts?.[1]).toMatchObject({
    origin: "runtime",
    observation: "present",
    source: "/mnt/c/work/app",
    lifetime: "retained",
  });
});

test("matches Windows bind spelling without guessing a guest-path translation", async () => {
  const { row } = await runInfo(
    withAppMount(service, { ...appMount, source: AbsolutePath.make("C:\\work\\app") }),
    { status: "present", mounts: [{ type: "bind", source: "c:/WORK/app", target: "/app", readOnly: true }] },
  );
  expect(row?.mounts).toHaveLength(1);
  expect(row?.mounts?.[0]).toMatchObject({ origin: "planned", observation: "present", readOnly: true });
});

test("keeps unavailable source evidence unknown rather than confirming a declared store", async () => {
  const { row } = await runInfo(
    {
      ...service,
      mounts: [{ type: "volume", store: "expected", target: PortablePath.make("/data"), readOnly: false }],
    },
    { status: "present", mounts: [{ type: "volume", target: "/data" }] },
  );
  expect(row?.mounts?.[0]?.observation).toBe("unknown");
  expect(row?.mounts?.[1]).toMatchObject({ origin: "runtime", lifetime: "unknown" });
});

test("omits internal agent and host-proxy mounts from user storage facts", async () => {
  const targets = [
    AGENT_SOCKET_CONTAINER_DIR.ssh,
    AGENT_SOCKET_CONTAINER_DIR.gpg,
    "/run/lando/gpg-agent-keys",
    "/run/lando/host-proxy.sock",
    "/usr/local/bin/lando",
    "/usr/local/bin/xdg-open",
    "/usr/local/bin/open",
  ];
  const selected: ServicePlan = {
    ...service,
    environment: {
      LANDO_HOST_PROXY_SESSION: "session",
      SSH_AUTH_SOCK: "/run/lando/ssh-agent/agent.sock",
      LANDO_GPG_AGENT_SOCKET: "/run/lando/gpg-agent/S.gpg-agent",
      LANDO_GPG_KEYRING: "/run/lando/gpg-agent-keys",
    },
    mounts: targets.map((target) => ({
      type: "volume" as const,
      store: "internal",
      target: PortablePath.make(target),
      readOnly: true,
    })),
  };
  const { row } = await runInfo(
    {
      ...selected,
      mounts: selected.mounts.map((mount) =>
        mount.target.startsWith("/usr/local") || mount.target === "/run/lando/host-proxy.sock"
          ? {
              type: "bind" as const,
              source: mount.type === "volume" ? mount.store : "internal",
              target: mount.target,
              readOnly: mount.readOnly,
              realization: "passthrough" as const,
            }
          : mount,
      ),
    },
    { status: "present", mounts: targets.map((target) => ({ type: "volume", source: "internal", target })) },
  );
  expect(row?.mounts).toEqual([]);
});

test("keeps disabled app mounts absent and unavailable tables distinct from observed empty", async () => {
  const unavailable = await runInfo(service);
  const empty = await runInfo(service, { status: "present", mounts: [] });
  expect(unavailable.row?.mounts).toBeUndefined();
  expect(unavailable.row?.appMount).toBeUndefined();
  expect(empty.row?.mounts).toEqual([]);
});

test("does not hide a user mount solely because it shares a host-proxy target", async () => {
  const selected: ServicePlan = {
    ...service,
    mounts: [
      {
        type: "bind",
        source: "/host/tool",
        target: PortablePath.make("/usr/local/bin/lando"),
        readOnly: true,
        realization: "passthrough",
      },
    ],
  };
  const { row } = await runInfo(selected, {
    status: "present",
    mounts: [{ type: "bind", source: "/host/tool", target: "/usr/local/bin/lando", readOnly: true }],
  });
  expect(row?.mounts).toEqual([
    {
      type: "bind",
      source: "/host/tool",
      target: "/usr/local/bin/lando",
      readOnly: true,
      origin: "planned",
      observation: "present",
      lifetime: "retained",
    },
  ]);
});
