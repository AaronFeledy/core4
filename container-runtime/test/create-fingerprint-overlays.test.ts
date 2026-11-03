import { expect, test } from "bun:test";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type BindMountPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { DateTime } from "effect";
import { CREATE_CONFIG_LABEL } from "../src/create-fingerprint.ts";
import { HOST_PROXY_TRANSPORT_EXTENSION_KEY } from "../src/labels.ts";
import { commonContainerLabels } from "../src/plan.ts";

const metadata = { resolvedAt: DateTime.makeUnsafe(0), source: "overlay-goldens", runtime: 4 as const };
const service: ServicePlan = {
  name: ServiceName.make("web"),
  type: "node",
  provider: ProviderId.make("podman"),
  primary: true,
  artifact: { kind: "ref", ref: "alpine:3" },
  environment: {},
  mounts: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};
const plan: AppPlan = {
  valueModel: 1,
  id: AppId.make("overlay-goldens"),
  name: "overlay-goldens",
  slug: "overlay-goldens",
  root: AbsolutePath.make("/host/app"),
  provider: service.provider,
  services: { [service.name]: service },
  routes: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};
const bind = (target: string): BindMountPlan => ({
  type: "bind",
  source: "/session/one",
  target: PortablePath.make(target),
  readOnly: true,
  realization: "passthrough",
  origin: "integration",
});
const overlays: Readonly<Record<string, ServicePlan>> = {
  plain: service,
  ssh: {
    ...service,
    environment: { SSH_AUTH_SOCK: "/run/lando/ssh-agent/agent.sock" },
    mounts: [bind("/run/lando/ssh-agent")],
  },
  gpg: {
    ...service,
    environment: {
      GNUPGHOME: "/tmp/lando-gnupg",
      LANDO_GPG_AGENT_SOCKET: "/run/lando/gpg-agent/S.gpg-agent",
      LANDO_GPG_KEYRING: "/run/lando/gpg-agent-keys",
    },
    mounts: [bind("/run/lando/gpg-agent"), bind("/run/lando/gpg-agent-keys")],
  },
  hostProxy: {
    ...service,
    environment: {
      LANDO_HOST_PROXY_SOCKET: "/run/lando/host-proxy.sock",
      LANDO_HOST_PROXY_TRANSPORT: "unix-socket",
      LANDO_HOST_PROXY_DEPTH: "0",
    },
    mounts: [
      "/run/lando/host-proxy.sock",
      "/run/lando/host-proxy/credentials",
      "/usr/local/bin/lando",
      "/usr/local/bin/xdg-open",
      "/usr/local/bin/open",
    ].map(bind),
    extensions: { [HOST_PROXY_TRANSPORT_EXTENSION_KEY]: { sessionDigest: "0123456789abcdef" } },
  },
  knownHosts: {
    ...service,
    environment: { SSH_AUTH_SOCK: "/run/lando/ssh-agent/agent.sock" },
    mounts: [
      bind("/run/lando/ssh-agent"),
      { ...bind("/etc/ssh/ssh_known_hosts"), source: "/home/user/.ssh/known_hosts", createHostPath: false },
    ],
  },
};

test("pins v4 create identities across integration overlays", () => {
  // Given representative plans with absent optional fields and exact integration evidence.
  // When the provider emits its immutable-create label.
  const fingerprints = Object.fromEntries(
    Object.entries(overlays).map(([name, selected]) => [
      name,
      commonContainerLabels(plan, selected)[CREATE_CONFIG_LABEL],
    ]),
  );
  // Then session overlays share one identity while the known-hosts bind changes it.
  expect(fingerprints).toEqual({
    plain: "v4:3bf8e0bb1892dcb3d7520d1d3168f152bb78d4b21eaf2996e48b3761796738dc",
    ssh: "v4:3bf8e0bb1892dcb3d7520d1d3168f152bb78d4b21eaf2996e48b3761796738dc",
    gpg: "v4:3bf8e0bb1892dcb3d7520d1d3168f152bb78d4b21eaf2996e48b3761796738dc",
    hostProxy: "v4:3bf8e0bb1892dcb3d7520d1d3168f152bb78d4b21eaf2996e48b3761796738dc",
    knownHosts: "v4:f288588ed03be182e4058d6223e3466f3db0ba54bd2b37e861f23fdead5f17b7",
  });
});

test("fingerprints source identity only when a bind defines it", () => {
  // Given an ordinary known_hosts bind, not an excluded session mount.
  const mount = {
    ...bind("/etc/ssh/ssh_known_hosts"),
    source: "/home/user/.ssh/known_hosts",
    createHostPath: false,
  };
  const fingerprint = (sourceIdentity?: string) =>
    commonContainerLabels(plan, {
      ...service,
      mounts: [{ ...mount, ...(sourceIdentity === undefined ? {} : { sourceIdentity }) }],
    })[CREATE_CONFIG_LABEL];
  // When inode identity is introduced or replaced.
  const absent = fingerprint();
  const original = fingerprint("2049:9007199254740993");
  const replaced = fingerprint("2049:9007199254740994");
  // Then old plans keep their exact bytes while a new inode requires reconciliation.
  expect(absent).toBe("v4:f288588ed03be182e4058d6223e3466f3db0ba54bd2b37e861f23fdead5f17b7");
  expect(new Set([absent, original, replaced]).size).toBe(3);
});
