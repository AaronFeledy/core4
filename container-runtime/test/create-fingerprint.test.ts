import { describe, expect, test } from "bun:test";
import { makeRedactionService } from "@lando/redaction/service";
import { sha256Hex } from "@lando/sdk/digest";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ContainerUser,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
  landoNetworkingPlan,
} from "@lando/sdk/schema";
import { DateTime, Effect } from "effect";
import { CREATE_CONFIG_LABEL } from "../src/create-fingerprint.ts";
import {
  AGENT_SESSION_LABEL,
  HOST_PROXY_SESSION_LABEL,
  HOST_PROXY_TRANSPORT_EXTENSION_KEY,
} from "../src/labels.ts";
import { commonContainerLabels, containerCreateBodyFragment } from "../src/plan.ts";
import { renderCompose } from "../src/podman/compose.ts";

const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-09-01T00:00:00Z"),
  source: "fingerprint",
  runtime: 4 as const,
};
const service: ServicePlan = {
  name: ServiceName.make("web"),
  type: "web",
  provider: ProviderId.make("lando"),
  primary: true,
  artifact: { kind: "ref", ref: "nginx:1.27-alpine", digest: "sha256:before" },
  environment: { MODE: "before", PASSWORD: "${secret:db/password}" },
  mounts: [],
  endpoints: [],
  hostAliases: [],
  routes: [],
  dependsOn: [],
  metadata,
  extensions: {},
};
const plan: AppPlan = {
  valueModel: 1,
  id: AppId.make("fingerprint"),
  name: "Fingerprint",
  slug: "fingerprint",
  root: AbsolutePath.make("/tmp/fingerprint"),
  provider: service.provider,
  services: { [service.name]: service },
  routes: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};
const fingerprint = (value: ServicePlan, app: AppPlan = plan) =>
  commonContainerLabels(app, value)[CREATE_CONFIG_LABEL];

test("fingerprints probe identity, execution locus, argv/shell semantics and host cwd", () => {
  // Given
  const readiness = {
    kind: "command",
    command: ["ready", "a b"],
    intervalSeconds: 0,
    timeoutSeconds: 1,
    retries: 1,
  } as const;
  const baseline = fingerprint({ ...service, readiness });
  // When
  const variants = [
    fingerprint({ ...service, readiness: { ...readiness, user: ContainerUser.make("1001") } }),
    fingerprint({ ...service, readiness: { ...readiness, executionTarget: "host" } }),
    fingerprint({ ...service, readiness: { ...readiness, command: "ready a b" } }),
    fingerprint(
      { ...service, readiness: { ...readiness, executionTarget: "host" } },
      { ...plan, root: AbsolutePath.make("/tmp/other-probe-root") },
    ),
  ];
  // Then
  expect(new Set([baseline, ...variants]).size).toBe(5);
});

const fixtureRedaction = makeRedactionService();

describe("desired immutable create config", () => {
  test("pins the mount-list-only default fingerprint bytes", () => {
    // Given the default plan without authored networks or bridge aliases.
    // When / Then the mount-only create projection stays pinned.
    expect(fingerprint(service)).toBe("v3:ff31e0d13cdd99844ead8b79b3d972ea97ff8f331f26997d674feaa6c3dd4bb8");
  });
  test("keeps explicit shared membership attachments and fingerprint byte-identical to the legacy plan", () => {
    // Given
    const explicit = {
      ...plan,
      networking: landoNetworkingPlan({
        slug: plan.slug,
        serviceNames: [service.name],
        sharedCrossAppNetwork: true,
      }),
    };
    // When
    const actual = fingerprint(service, explicit);
    // Then
    expect(actual).toBe("v3:ff31e0d13cdd99844ead8b79b3d972ea97ff8f331f26997d674feaa6c3dd4bb8");
  });

  test.each(["membership", "bridge aliases", "authored aliases"])("fingerprints %s changes", (change) => {
    // Given one member service and an authored network.
    const networking = (changed: boolean) =>
      landoNetworkingPlan({
        slug: plan.slug,
        serviceNames: [service.name],
        sharedCrossAppNetwork: true,
        bridgeAliases: changed && change === "bridge aliases" ? { web: ["frontend"] } : {},
        authoredNetworks:
          changed && change === "membership"
            ? []
            : [
                {
                  key: "extra",
                  external: false,
                  members: { web: changed && change === "authored aliases" ? ["alias"] : [] },
                },
              ],
      });
    // When / Then attachment changes alter the immutable create identity.
    expect(fingerprint(service, { ...plan, networking: networking(true) })).not.toBe(
      fingerprint(service, { ...plan, networking: networking(false) }),
    );
  });
  test("distinguishes literal, reference, raw composite, and encoded composite identities", () => {
    // Given
    const values = [
      "${secret:TOKEN}",
      { _tag: "SecretRef", reference: "TOKEN" },
      { _tag: "BoundText", parts: ["prefix", { reference: "TOKEN", encoding: "raw" }] },
      { _tag: "BoundText", parts: ["prefix", { reference: "TOKEN", encoding: "uri-component" }] },
    ] as const;
    // When
    const fingerprints = values.map((value) => fingerprint({ ...service, environment: { TOKEN: value } }));
    // Then
    expect(new Set(fingerprints).size).toBe(values.length);
  });

  type FingerprintChange = Partial<Omit<ServicePlan, "connection" | "nonSqlCreds">>;
  const changes: ReadonlyArray<readonly [string, FingerprintChange]> = [
    ["environment", { environment: { MODE: "after" } }],
    ["command", { command: ["sleep", "60"] }],
    ["entrypoint", { entrypoint: ["/entrypoint"] }],
    ["image ref", { artifact: { kind: "ref", ref: "nginx:other", digest: "sha256:before" } }],
    ["image digest", { artifact: { kind: "ref", ref: "nginx:1.27-alpine", digest: "sha256:after" } }],
    ["working directory", { workingDirectory: PortablePath.make("/work") }],
    ["user", { user: "1000:1000" }],
    [
      "app mount",
      {
        mounts: [
          {
            type: "bind",
            role: "app",
            source: plan.root,
            target: PortablePath.make("/app"),
            readOnly: false,
            realization: "passthrough",
            excludes: [],
            includes: [],
          },
        ],
      },
    ],
    [
      "bind",
      {
        mounts: [
          {
            type: "bind",
            source: "/config",
            target: PortablePath.make("/config"),
            readOnly: true,
            realization: "passthrough",
            createHostPath: false,
          },
        ],
      },
    ],
    [
      "storage subpath",
      {
        mounts: [
          {
            type: "volume",
            store: "data",
            target: PortablePath.make("/data"),
            readOnly: false,
            subpath: "tenant",
          },
        ],
      },
    ],
    ["healthcheck", { healthcheck: { kind: "none", intervalSeconds: 10, timeoutSeconds: 5, retries: 3 } }],
    ["exposed port", { endpoints: [{ _tag: "internal", port: 8080, protocol: "tcp" }] }],
    ["host alias", { hostAliases: [{ hostname: "gateway", ip: "192.0.2.1" }] }],
    ["user labels", { extensions: { compose: { labels: { role: "web" } } } }],
    ["host config knob", { extensions: { compose: { privileged: true } } }],
    ["top-level knob", { extensions: { compose: { stop_signal: "SIGQUIT" } } }],
    ["query knob", { extensions: { compose: { platform: "linux/arm64" } } }],
    [
      "tmpfs options",
      {
        mounts: [
          {
            type: "tmpfs",
            target: PortablePath.make("/scratch"),
            readOnly: true,
            options: "size=64m,mode=1777",
          },
        ],
      },
    ],
  ];
  test.each(changes)("changes the fingerprint for %s drift", (_name, change) => {
    // Given two desired configurations differing in one immutable input.
    const updated = { ...service, ...change };
    // When both label sets are emitted.
    const actual = fingerprint(updated);
    // Then drift is visible without putting configuration bytes in labels.
    expect(actual).not.toBe(fingerprint(service));
    expect(actual).toMatch(/^v3:[a-f0-9]{64}$/u);
  });

  test("normalizes command and entrypoint representations without sorting argv", () => {
    // Given equivalent shell-command and entrypoint representations.
    const authored = { ...service, command: "sleep 60", entrypoint: "/bin/tool" };
    const normalized = { ...service, command: ["sh", "-lc", "sleep 60"], entrypoint: ["/bin/tool"] };
    // When fingerprints are emitted.
    const actual = fingerprint(authored);
    // Then equivalent create arguments match and reordered arguments do not.
    expect(actual).toBe(fingerprint(normalized));
    expect(actual).not.toBe(fingerprint({ ...normalized, command: ["sleep 60", "-lc", "sh"] }));
  });

  test("ignores bind sync metadata but fingerprints its physical volume identity", () => {
    const mount = {
      type: "bind",
      source: "/host/app",
      target: PortablePath.make("/app"),
      readOnly: false,
      realization: "accelerated",
      mountKey: "app-mount",
    } as const;
    const before: ServicePlan = { ...service, mounts: [mount] };
    const metadataOnly: ServicePlan = {
      ...before,
      mounts: [{ ...mount, role: "app", excludes: ["vendor"], includes: [".git"] }],
    };
    const changedIdentity: ServicePlan = { ...before, mounts: [{ ...mount, mountKey: "mount-deadbeef" }] };
    expect(fingerprint(metadataOnly)).toBe(fingerprint(before));
    expect(fingerprint(changedIdentity)).not.toBe(fingerprint(before));
  });

  test("fingerprints tmpfs runtime options independently of its target", () => {
    const mount = {
      type: "tmpfs",
      target: PortablePath.make("/scratch"),
      readOnly: false,
      options: "size=64m",
    } as const;
    const before: ServicePlan = { ...service, mounts: [mount] };
    const after: ServicePlan = { ...service, mounts: [{ ...mount, options: "size=128m" }] };
    expect(fingerprint(after)).not.toBe(fingerprint(before));
  });

  test("changes the fingerprint when publication bindAddress changes", () => {
    // Given two published endpoints that differ only in host bind.
    const published = (bindAddress: string): ServicePlan => ({
      ...service,
      endpoints: [
        {
          _tag: "published",
          port: 80,
          protocol: "http",
          publication: { bindAddress, hostPort: 8080 },
        },
      ],
    });
    // When both label sets are emitted.
    const loopback = fingerprint(published("127.0.0.1"));
    const lan = fingerprint(published("0.0.0.0"));
    // Then a bind change is visible create-config drift.
    expect(lan).not.toBe(loopback);
    expect(lan).toMatch(/^v3:[a-f0-9]{64}$/u);
  });

  test("ignores map order, metadata, runtime host ports, and unrelated extensions", () => {
    // Given identical desired create config with different runtime observations.
    const endpoint = { _tag: "published" as const, port: 8080, protocol: "http" as const, publication: {} };
    const observedBefore = { ...endpoint, materialization: { hostPort: 32001, bindAddress: "127.0.0.1" } };
    const observedAfter = { ...endpoint, materialization: { hostPort: 32002, bindAddress: "127.0.0.1" } };
    const before: ServicePlan = { ...service, endpoints: [observedBefore] };
    const after: ServicePlan = {
      ...before,
      environment: { PASSWORD: "${secret:db/password}", MODE: "before" },
      endpoints: [observedAfter],
      metadata: { ...metadata, resolvedAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z") },
      extensions: { unrelated: { probe: "different" } },
    };
    // When the labels are emitted for both plans.
    const actual = fingerprint(after, { ...plan, metadata: after.metadata });
    // Then allocation and observation changes leave the desired digest stable.
    expect(actual).toBe(fingerprint(before));
  });

  test("hashes desired secret references and literal config without consulting redaction state", () => {
    // Given authored secret references and a literal env-file-equivalent value.
    const desired = {
      ...service,
      environment: { PASSWORD: "${secret:db/password}", LITERAL: "credential-canary" },
    };
    const before = fingerprint(desired);
    Effect.runSync(fixtureRedaction.registerValues(["credential-canary", "${secret:db/password}"]));
    // When registered redaction values change before another label emission.
    const after = fingerprint(desired);
    // Then redaction cannot collapse distinct desired values or expose raw values in the label.
    expect(after).toBe(before);
    expect(after).toMatch(/^v3:[a-f0-9]{64}$/u);
    expect(after).not.toContain("credential-canary");
    expect(after).not.toBe(
      fingerprint({ ...desired, environment: { ...desired.environment, PASSWORD: "${secret:db/other}" } }),
    );
    expect(after).not.toBe(
      fingerprint({ ...desired, environment: { ...desired.environment, LITERAL: "other-credential" } }),
    );
  });

  const hostProxySessionDigestOf = (session: string): string => sha256Hex(session).slice(0, 16);
  const trustedHostProxyExtension = (session: string): ServicePlan["extensions"] => ({
    [HOST_PROXY_TRANSPORT_EXTENSION_KEY]: { sessionDigest: hostProxySessionDigestOf(session) },
  });
  const hostProxySessionMounts = (source: string): ServicePlan["mounts"] =>
    [
      "/run/lando/host-proxy.sock",
      "/run/lando/host-proxy/credentials",
      "/usr/local/bin/lando",
      "/usr/local/bin/xdg-open",
      "/usr/local/bin/open",
    ].map((target) => ({
      type: "bind" as const,
      source,
      target: PortablePath.make(target),
      readOnly: true,
      realization: "passthrough" as const,
    }));

  test("normalizes trusted host-proxy overlays without token/session/app env", () => {
    // Given a credentials-file overlay: trusted extension digest, socket/credentials/shim binds, no credential env.
    const overlay: ServicePlan = {
      ...service,
      environment: {
        ...service.environment,
        LANDO_HOST_IP: "192.0.2.9",
        LANDO_HOST_PROXY_SOCKET: "/run/lando/host-proxy.sock",
        LANDO_HOST_PROXY_URL: "http://gateway:32001",
        LANDO_HOST_PROXY_TRANSPORT: "tcp-host-gateway",
        LANDO_HOST_PROXY_DEPTH: "0",
        SSH_AUTH_SOCK: "/run/lando/ssh-agent/agent.sock",
        GNUPGHOME: "/tmp/lando-gnupg",
        LANDO_GPG_AGENT_SOCKET: "/run/lando/gpg-agent/S.gpg-agent",
        LANDO_GPG_KEYRING: "/run/lando/gpg-agent-keys",
      },
      mounts: [
        ...hostProxySessionMounts("/session/one"),
        ...["/run/lando/ssh-agent", "/run/lando/gpg-agent", "/run/lando/gpg-agent-keys"].map((target) => ({
          type: "bind" as const,
          source: "/session/one",
          target: PortablePath.make(target),
          readOnly: true,
          realization: "passthrough" as const,
        })),
      ],
      extensions: trustedHostProxyExtension("session-1"),
    };
    // When the label is computed for the overlay-bearing plan.
    const actual = fingerprint(overlay);
    // Then trusted session binds (including credentials) and remaining host-proxy env do not drift create-config.
    expect(actual).toBe(fingerprint(service));
    expect(actual).toBe(
      fingerprint({
        ...overlay,
        environment: {
          ...overlay.environment,
          LANDO_HOST_PROXY_URL: "http://gateway:32002",
          LANDO_HOST_PROXY_DEPTH: "1",
        },
        mounts: overlay.mounts.map((mount) => ({ ...mount, source: "/session/two" })),
        extensions: trustedHostProxyExtension("session-2"),
      }),
    );
    expect(commonContainerLabels(plan, overlay)[HOST_PROXY_SESSION_LABEL]).toBe(
      hostProxySessionDigestOf("session-1"),
    );
    expect(actual).not.toBe(
      fingerprint({
        ...service,
        environment: { ...service.environment, SSH_AUTH_SOCK: "/custom/auth.sock" },
      }),
    );
    expect(actual).not.toBe(
      fingerprint({ ...service, environment: { ...service.environment, LANDO_CUSTOM: "authored" } }),
    );
    expect(actual).not.toBe(
      fingerprint({
        ...service,
        mounts: [
          {
            type: "bind",
            source: "/authored",
            target: PortablePath.make("/usr/local/bin/lando"),
            readOnly: true,
            realization: "passthrough",
          },
        ],
      }),
    );
  });

  test("legacy env-only host-proxy overlay does not exclude session binds from create-config", () => {
    // Given the pre-credentials-file overlay: SESSION/TOKEN/APP env and socket/shim binds, no trusted extension.
    const legacy: ServicePlan = {
      ...service,
      environment: {
        ...service.environment,
        LANDO_HOST_PROXY_SESSION: "session-1",
        LANDO_HOST_PROXY_TOKEN: "token-1",
        LANDO_HOST_PROXY_APP: "app-1",
        LANDO_HOST_PROXY_SOCKET: "/run/lando/host-proxy.sock",
        LANDO_HOST_PROXY_TRANSPORT: "unix-socket",
      },
      mounts: hostProxySessionMounts("/session/legacy").filter(
        (mount) => mount.target !== "/run/lando/host-proxy/credentials",
      ),
    };
    // When fingerprints are compared against the bare service and a source rotation.
    const bare = fingerprint(service);
    const withBinds = fingerprint(legacy);
    const rotated = fingerprint({
      ...legacy,
      mounts: legacy.mounts.map((mount) => ({ ...mount, source: "/session/legacy-2" })),
    });
    // Then env alone never stamps a session label or excludes host-proxy binds from the digest.
    expect(commonContainerLabels(plan, legacy)[HOST_PROXY_SESSION_LABEL]).toBeUndefined();
    expect(withBinds).not.toBe(bare);
    expect(rotated).not.toBe(withBinds);
    // And a forged session label still cannot unlock bind exclusion without the trusted extension.
    expect(
      fingerprint({
        ...legacy,
        extensions: {
          compose: { labels: { [HOST_PROXY_SESSION_LABEL]: hostProxySessionDigestOf("session-1") } },
        },
      }),
    ).toBe(withBinds);
  });

  test("trusted extension excludes the credentials bind the same way as the socket bind", () => {
    // Given only the credentials bind under a trusted extension.
    const withCredentials: ServicePlan = {
      ...service,
      mounts: [
        {
          type: "bind",
          source: "/run/session/credentials",
          target: PortablePath.make("/run/lando/host-proxy/credentials"),
          readOnly: true,
          realization: "passthrough",
        },
      ],
      extensions: trustedHostProxyExtension("session-credentials"),
    };
    // When sources rotate under the same trusted digest.
    const rotated = {
      ...withCredentials,
      mounts: withCredentials.mounts.map((mount) => ({ ...mount, source: "/run/session/credentials-2" })),
    };
    // Then credentials remain outside create-config identity.
    expect(fingerprint(withCredentials)).toBe(fingerprint(service));
    expect(fingerprint(rotated)).toBe(fingerprint(service));
  });

  test("overrides a user-supplied fingerprint and excludes the agent session label", () => {
    // Given spoofed self-label input and per-apply agent-session metadata.
    const spoofed = { ...service, extensions: { compose: { labels: { [CREATE_CONFIG_LABEL]: "spoofed" } } } };
    // When final create labels are built.
    const labels = commonContainerLabels(plan, spoofed, { [AGENT_SESSION_LABEL]: "session-1" });
    // Then the self-label is computed last and never hashes itself or a session id.
    expect(labels[CREATE_CONFIG_LABEL]).toBe(fingerprint(service));
    expect(labels[AGENT_SESSION_LABEL]).toBe("session-1");
  });

  test("emits the identical fingerprint through Compose and direct create", () => {
    // Given one desired service consumed by both provider paths.
    const body = containerCreateBodyFragment(plan, service);
    // When Compose emits that same plan.
    const content = renderCompose(plan, { providerId: "podman", remediation: "Retry.", env: {} });
    // Then both actual output surfaces carry the same opaque label.
    expect(body).toMatchObject({ Labels: { [CREATE_CONFIG_LABEL]: fingerprint(service) } });
    expect(content).toContain(`dev.lando.create-config: "${fingerprint(service)}"`);
  });
});
