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

test("preserves literal v3 create identities captured before overlay refactoring", () => {
  // Given representative plans with absent optional fields and exact integration evidence.
  // When the provider emits its existing immutable-create label.
  const fingerprints = Object.fromEntries(
    Object.entries(overlays).map(([name, selected]) => [
      name,
      commonContainerLabels(plan, selected)[CREATE_CONFIG_LABEL],
    ]),
  );
  // Then existing persisted identities remain byte-identical.
  expect(fingerprints).toEqual({
    plain: "v3:37e6333e3a440a2fc70897f5ce789bc06b827616038577abd43ded7242276ab5",
    ssh: "v3:37e6333e3a440a2fc70897f5ce789bc06b827616038577abd43ded7242276ab5",
    gpg: "v3:37e6333e3a440a2fc70897f5ce789bc06b827616038577abd43ded7242276ab5",
    hostProxy: "v3:37e6333e3a440a2fc70897f5ce789bc06b827616038577abd43ded7242276ab5",
    knownHosts: "v3:9e9b6b9f855df341f570cd09a8817283d6ffbf0116f0b3bfac06602b7ff28cbb",
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
  expect(absent).toBe("v3:9e9b6b9f855df341f570cd09a8817283d6ffbf0116f0b3bfac06602b7ff28cbb");
  expect(new Set([absent, original, replaced]).size).toBe(3);
});
