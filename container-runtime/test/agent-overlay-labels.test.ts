import { expect, test } from "bun:test";
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
  storage: [],
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
