// Hand-written independently of the production registry. Both the realizer and
// final-request suites consume these tables per engine dialect, while the
// declaration test diffs each dialect's keys against its published capability set.
export interface KnobRealization {
  readonly hostConfig: Record<string, unknown>;
  readonly topLevel: Record<string, unknown>;
  readonly query: Record<string, string>;
}

interface KnobFixture {
  readonly input: Record<string, unknown>;
  readonly expected: KnobRealization;
}

const inHostConfig = (fragment: Record<string, unknown>): KnobRealization => ({
  hostConfig: fragment,
  topLevel: {},
  query: {},
});

const inTopLevel = (fragment: Record<string, unknown>): KnobRealization => ({
  hostConfig: {},
  topLevel: fragment,
  query: {},
});

const inQuery = (fragment: Record<string, string>): KnobRealization => ({
  hostConfig: {},
  topLevel: {},
  query: fragment,
});

const SHARED_KNOB_FIXTURES = {
  restart: {
    input: { restart: "unless-stopped" },
    expected: inHostConfig({ RestartPolicy: { Name: "unless-stopped" } }),
  },
  cap_add: {
    input: { cap_add: ["NET_ADMIN", "SYS_PTRACE"] },
    expected: inHostConfig({ CapAdd: ["NET_ADMIN", "SYS_PTRACE"] }),
  },
  cap_drop: {
    input: { cap_drop: ["MKNOD"] },
    expected: inHostConfig({ CapDrop: ["MKNOD"] }),
  },
  privileged: {
    input: { privileged: true },
    expected: inHostConfig({ Privileged: true }),
  },
  devices: {
    input: { devices: [{ source: "/dev/sda", target: "/dev/xvda", permissions: "rwm" }] },
    expected: inHostConfig({
      Devices: [{ PathOnHost: "/dev/sda", PathInContainer: "/dev/xvda", CgroupPermissions: "rwm" }],
    }),
  },
  ulimits: {
    input: { ulimits: { nofile: { soft: 20000, hard: 40000 } } },
    expected: inHostConfig({ Ulimits: [{ Name: "nofile", Soft: 20000, Hard: 40000 }] }),
  },
  sysctls: {
    input: { sysctls: { "net.core.somaxconn": 1024 } },
    expected: inHostConfig({ Sysctls: { "net.core.somaxconn": "1024" } }),
  },
  shm_size: {
    input: { shm_size: 67108864 },
    expected: inHostConfig({ ShmSize: 67108864 }),
  },
  dns: {
    input: { dns: ["8.8.8.8", "1.1.1.1"] },
    expected: inHostConfig({ Dns: ["8.8.8.8", "1.1.1.1"] }),
  },
  dns_search: {
    input: { dns_search: ["example.com"] },
    expected: inHostConfig({ DnsSearch: ["example.com"] }),
  },
  dns_opt: {
    input: { dns_opt: ["ndots:2"] },
    expected: inHostConfig({ DnsOptions: ["ndots:2"] }),
  },
  extra_hosts: {
    input: { extra_hosts: { "host.local": "10.0.0.1" } },
    expected: inHostConfig({ ExtraHosts: ["host.local:10.0.0.1"] }),
  },
  stop_signal: {
    input: { stop_signal: "SIGUSR1" },
    expected: inTopLevel({ StopSignal: "SIGUSR1" }),
  },
  stop_grace_period: {
    input: { stop_grace_period: 30 },
    expected: inTopLevel({ StopTimeout: 30 }),
  },
  security_opt: {
    input: { security_opt: ["label=disable"] },
    expected: inHostConfig({ SecurityOpt: ["label=disable"] }),
  },
  group_add: {
    input: { group_add: ["audio", 1001] },
    expected: inHostConfig({ GroupAdd: ["audio", "1001"] }),
  },
  read_only: {
    input: { read_only: true },
    expected: inHostConfig({ ReadonlyRootfs: true }),
  },
  platform: {
    input: { platform: "linux/amd64" },
    expected: inQuery({ platform: "linux/amd64" }),
  },
  logging: {
    input: { logging: { driver: "json-file", options: { "max-size": "10m" } } },
    expected: inHostConfig({ LogConfig: { Type: "json-file", Config: { "max-size": "10m" } } }),
  },
  "deploy.resources": {
    input: {
      deploy: {
        resources: {
          limits: { memory: 268_435_456, cpus: "0.5", pids: 100 },
          reservations: { memory: 134_217_728 },
        },
      },
    },
    expected: inHostConfig({
      Memory: 268_435_456,
      NanoCpus: 500_000_000,
      PidsLimit: 100,
      MemoryReservation: 134_217_728,
    }),
  },
} satisfies Record<string, KnobFixture>;

// Docker Engine honors device requests verbatim; Podman's compat API ignores
// everything but CDI device names, so libpod declares neither knob.
const DOCKER_ONLY_KNOB_FIXTURES = {
  gpus: {
    input: { gpus: [{ driver: "nvidia", device_ids: ["0", "1"], capabilities: ["compute"] }] },
    expected: inHostConfig({
      DeviceRequests: [
        { Driver: "nvidia", Count: 0, DeviceIDs: ["0", "1"], Capabilities: [["compute", "gpu"]] },
      ],
    }),
  },
  "deploy.resources.reservations.devices": {
    input: {
      deploy: {
        resources: {
          reservations: {
            devices: [{ driver: "nvidia", count: 1, capabilities: ["gpu"], options: { mode: "compute" } }],
          },
        },
      },
    },
    expected: inHostConfig({
      DeviceRequests: [{ Driver: "nvidia", Count: 1, Capabilities: [["gpu"]], Options: { mode: "compute" } }],
    }),
  },
} satisfies Record<string, KnobFixture>;

export const KNOB_FIXTURES_BY_DIALECT: Readonly<
  Record<"libpod" | "docker", Readonly<Record<string, KnobFixture>>>
> = {
  libpod: SHARED_KNOB_FIXTURES,
  docker: { ...SHARED_KNOB_FIXTURES, ...DOCKER_ONLY_KNOB_FIXTURES },
};

export const EMPTY_REALIZATION: KnobRealization = { hostConfig: {}, topLevel: {}, query: {} };
