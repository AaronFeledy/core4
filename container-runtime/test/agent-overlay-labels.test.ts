import { expect, test } from "bun:test";
import { sha256Hex } from "@lando/sdk/digest";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { DateTime } from "effect";
import { CREATE_CONFIG_LABEL, createConfigFingerprint } from "../src/create-fingerprint.ts";
import {
  HOST_PROXY_SESSION_LABEL,
  HOST_PROXY_TRANSPORT_EXTENSION_KEY,
  containerIntegrationLabels,
  hostProxySessionDigest,
} from "../src/labels.ts";
import { commonContainerLabels, containerCreateBodyFragment } from "../src/plan.ts";
import { renderCompose } from "../src/podman/compose.ts";

const metadata = { resolvedAt: DateTime.makeUnsafe(0), source: "agent-labels", runtime: 4 as const };
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
  id: AppId.make("agent-labels"),
  name: "agent-labels",
  slug: "agent-labels",
  root: AbsolutePath.make("/host/app"),
  provider: service.provider,
  services: { [service.name]: service },
  routes: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};
const cases = [
  { label: "dev.lando.ssh-agent-overlay", environment: { SSH_AUTH_SOCK: "/run/lando/ssh-agent/agent.sock" } },
  {
    label: "dev.lando.gpg-agent-overlay",
    environment: {
      LANDO_GPG_AGENT_SOCKET: "/run/lando/gpg-agent/S.gpg-agent",
      LANDO_GPG_KEYRING: "/run/lando/gpg-agent-keys",
    },
  },
] as const;

test.each([...cases])(
  "stamps $label from exact injection evidence in both create paths",
  ({ label, environment }) => {
    // Given
    const selected = { ...service, environment, extensions: { compose: { labels: { [label]: "forged" } } } };
    const applied = { ...plan, services: { [selected.name]: selected } };
    // When
    const body = containerCreateBodyFragment(applied, selected);
    const compose = renderCompose(applied, { providerId: "podman", remediation: "Retry.", env: {} });
    // Then
    expect(body).toMatchObject({ Labels: { [label]: "true" } });
    expect(compose).toContain(`${label}: "true"`);
  },
);

for (const { label, environment } of cases) {
  const inactive: readonly ServicePlan["environment"][] = [
    {},
    Object.fromEntries(Object.entries(environment).map(([key, value]) => [key, `${value}.other`])),
    Object.fromEntries(
      Object.keys(environment).map((key) => [key, { _tag: "SecretRef", reference: "user-value" }]),
    ),
    ...(Object.keys(environment).length > 1
      ? Object.entries(environment).map(([key, value]) => ({ [key]: value }))
      : []),
  ];
  test.each([...inactive])(
    `strips forged ${label} when injection evidence is incomplete: %j`,
    (environment) => {
      // Given: both user Compose labels and caller extras must lose a forged marker.
      const selected = {
        ...service,
        environment,
        extensions: { compose: { labels: { [label]: "true", keep: "user" } } },
      };
      // When
      const labels = commonContainerLabels(plan, selected, { [label]: "true" });
      // Then
      expect(labels[label]).toBeUndefined();
      expect(labels.keep).toBe("user");
    },
  );
}

test.each([...cases])("ignores $label session metadata in normalized fingerprints", ({ label }) => {
  // Given
  const baseline = createConfigFingerprint(plan, service, {});
  // When
  const marked = createConfigFingerprint(plan, service, { [label]: "true" });
  // Then
  expect(marked).toBe(baseline);
});

test.each([...cases])("keeps $label activation out of normalized create identity", ({ environment }) => {
  // Given
  const baseline = commonContainerLabels(plan, service)[CREATE_CONFIG_LABEL];
  // When
  const labels = commonContainerLabels(plan, { ...service, environment });
  // Then
  expect(labels[CREATE_CONFIG_LABEL]).toBe(baseline);
});

const gpgSocket = "/run/lando/gpg-agent/S.gpg-agent";
const gpgKeyring = "/run/lando/gpg-agent-keys";
const gpgTargets = ["/run/lando/gpg-agent", gpgKeyring] as const;
const fingerprint = (selected: ServicePlan) => commonContainerLabels(plan, selected)[CREATE_CONFIG_LABEL];

for (const keyring of [undefined, "/user/keyring"]) {
  const environment = {
    LANDO_GPG_AGENT_SOCKET: gpgSocket,
    ...(keyring === undefined ? {} : { LANDO_GPG_KEYRING: keyring }),
  };
  test.each([...gpgTargets])(
    `tracks user bind source edits at %s with partial GPG keyring ${keyring}`,
    (target) => {
      // Given
      const mount = {
        type: "bind" as const,
        source: "/user/before",
        target: PortablePath.make(target),
        readOnly: true,
        realization: "passthrough" as const,
      };
      const before = fingerprint({ ...service, environment, mounts: [mount] });
      // When
      const after = fingerprint({ ...service, environment, mounts: [{ ...mount, source: "/user/after" }] });
      // Then
      expect(after).not.toBe(before);
    },
  );

  test(`tracks a user bind moving to the keyring target with partial GPG keyring ${keyring}`, () => {
    // Given
    const mount = {
      type: "bind" as const,
      source: "/user/keys",
      target: PortablePath.make("/run/lando/gpg-agent"),
      readOnly: true,
      realization: "passthrough" as const,
    };
    const before = fingerprint({ ...service, environment, mounts: [mount] });
    // When
    const after = fingerprint({
      ...service,
      environment,
      mounts: [{ ...mount, target: PortablePath.make(gpgKeyring) }],
    });
    // Then
    expect(after).not.toBe(before);
  });
}

test.each([
  { key: "LANDO_GPG_AGENT_SOCKET", value: gpgSocket },
  { key: "LANDO_GPG_KEYRING", value: gpgKeyring },
  { key: "GNUPGHOME", value: "/tmp/lando-gnupg" },
])("tracks authored $key removal when GPG integration is incomplete", ({ key, value }) => {
  // Given
  const before = fingerprint({ ...service, environment: { [key]: value } });
  // When
  const after = fingerprint(service);
  // Then
  expect(after).not.toBe(before);
});

test("normalizes complete GPG overlays across session mount source changes", () => {
  // Given
  const overlay: ServicePlan = {
    ...service,
    environment: {
      LANDO_GPG_AGENT_SOCKET: gpgSocket,
      LANDO_GPG_KEYRING: gpgKeyring,
      GNUPGHOME: "/tmp/lando-gnupg",
    },
    mounts: gpgTargets.map((target) => ({
      type: "bind",
      source: "/session/before",
      target: PortablePath.make(target),
      readOnly: true,
      realization: "passthrough",
    })),
  };
  const baseline = fingerprint(service);
  // When
  const fingerprints = [
    overlay,
    { ...overlay, mounts: overlay.mounts.map((mount) => ({ ...mount, source: "/session/after" })) },
  ].map(fingerprint);
  // Then
  expect(fingerprints).toEqual([baseline, baseline]);
});

const sessionDigest = (session: string): string => sha256Hex(session).slice(0, 16);
const trustedHostProxyExtension = (session: string): ServicePlan["extensions"] => ({
  [HOST_PROXY_TRANSPORT_EXTENSION_KEY]: { sessionDigest: sessionDigest(session) },
});

test("stamps host-proxy session label only from a trusted transport extension digest", () => {
  // Given a trusted overlay extension and a forged authored label of a different value.
  const digest = sessionDigest("session-alpha");
  const selected: ServicePlan = {
    ...service,
    environment: {
      LANDO_HOST_PROXY_SOCKET: "/run/lando/host-proxy.sock",
      LANDO_HOST_PROXY_TRANSPORT: "unix-socket",
      LANDO_HOST_PROXY_DEPTH: "0",
    },
    extensions: {
      ...trustedHostProxyExtension("session-alpha"),
      compose: { labels: { [HOST_PROXY_SESSION_LABEL]: "forged-digest" } },
    },
  };
  const applied = { ...plan, services: { [selected.name]: selected } };
  // When
  const body = containerCreateBodyFragment(applied, selected);
  const compose = renderCompose(applied, { providerId: "podman", remediation: "Retry.", env: {} });
  const labels = commonContainerLabels(plan, selected);
  // Then both provider paths emit the trusted digest and reject the authored spoof.
  expect(labels[HOST_PROXY_SESSION_LABEL]).toBe(digest);
  expect(body).toMatchObject({ Labels: { [HOST_PROXY_SESSION_LABEL]: digest } });
  expect(compose).toContain(`${HOST_PROXY_SESSION_LABEL}: "${digest}"`);
});

const hostProxyEnvironments: readonly ServicePlan["environment"][] = [
  {},
  {
    LANDO_HOST_PROXY_SESSION: "env-session",
    LANDO_HOST_PROXY_TOKEN: "token",
    LANDO_HOST_PROXY_APP: "app",
  },
  { LANDO_HOST_PROXY_SOCKET: "/run/lando/host-proxy.sock" },
];
test.each(hostProxyEnvironments)(
  "strips forged host-proxy-session labels without a trusted extension: %j",
  (environment) => {
    // Given env-era credentials and/or a forged Compose label without the transport extension.
    const selected: ServicePlan = {
      ...service,
      environment,
      extensions: { compose: { labels: { [HOST_PROXY_SESSION_LABEL]: "spoofed", keep: "user" } } },
    };
    // When
    const labels = commonContainerLabels(plan, selected, { [HOST_PROXY_SESSION_LABEL]: "caller-spoof" });
    // Then neither env nor authored labels can emit the session marker.
    expect(labels[HOST_PROXY_SESSION_LABEL]).toBeUndefined();
    expect(labels.keep).toBe("user");
    expect(hostProxySessionDigest({})).toBeUndefined();
    expect(
      containerIntegrationLabels(environment, { [HOST_PROXY_SESSION_LABEL]: "spoofed" }, {})[
        HOST_PROXY_SESSION_LABEL
      ],
    ).toBeUndefined();
  },
);

test.each([
  { sessionDigest: "tooshort" },
  { sessionDigest: "not-hex-but16chr!" },
  { sessionDigest: "ABCDEF0123456789" },
  { sessionDigest: "0123456789abcdef0" },
  "0123456789abcdef",
  null,
  12,
] as const)("rejects untrusted host-proxy transport extension payload %j", (payload) => {
  // Given a non-conforming extension value under the trusted key.
  const extensions: ServicePlan["extensions"] = { [HOST_PROXY_TRANSPORT_EXTENSION_KEY]: payload };
  // When / Then only `{ sessionDigest: /^[a-f0-9]{16}$/ }` is accepted.
  expect(hostProxySessionDigest(extensions)).toBeUndefined();
  expect(
    containerIntegrationLabels({}, { [HOST_PROXY_SESSION_LABEL]: "spoof" }, extensions)[
      HOST_PROXY_SESSION_LABEL
    ],
  ).toBeUndefined();
});

test("accepts a 16-char lowercase hex sessionDigest from the transport extension", () => {
  // Given
  const digest = "0123456789abcdef";
  const extensions = { [HOST_PROXY_TRANSPORT_EXTENSION_KEY]: { sessionDigest: digest } };
  // When / Then
  expect(hostProxySessionDigest(extensions)).toBe(digest);
  expect(containerIntegrationLabels({}, {}, extensions)[HOST_PROXY_SESSION_LABEL]).toBe(digest);
});

test("ignores host-proxy session metadata in normalized fingerprints", () => {
  // Given
  const baseline = createConfigFingerprint(plan, service, {});
  // When a session marker appears only as a label argument
  const marked = createConfigFingerprint(plan, service, {
    [HOST_PROXY_SESSION_LABEL]: sessionDigest("s"),
  });
  // Then the create identity is unchanged
  expect(marked).toBe(baseline);
});
