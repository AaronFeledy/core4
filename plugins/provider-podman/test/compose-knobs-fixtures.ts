// Hand-written independently of the production registry. The declaration test
// diffs these keys against each Podman-backed provider's published capability set.
interface KnobRealization {
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

export const KNOB_FIXTURES = {
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
  tmpfs: {
    input: { tmpfs: ["/run", "/tmp:size=64m"] },
    expected: inHostConfig({ Tmpfs: { "/run": "", "/tmp": "size=64m" } }),
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
  init: {
    input: { init: true },
    expected: inHostConfig({ Init: true }),
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
} satisfies Record<string, KnobFixture>;
