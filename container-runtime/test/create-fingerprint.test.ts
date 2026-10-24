import { describe, expect, test } from "bun:test";
import { makeRedactionService } from "@lando/redaction/service";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { DateTime, Effect } from "effect";
import { CREATE_CONFIG_LABEL } from "../src/create-fingerprint.ts";
import { AGENT_SESSION_LABEL } from "../src/labels.ts";
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
  storage: [],
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
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};
const fingerprint = (value: ServicePlan, app: AppPlan = plan) =>
  commonContainerLabels(app, value)[CREATE_CONFIG_LABEL];

const fixtureRedaction = makeRedactionService();

describe("desired immutable create config", () => {
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
        appMount: {
          source: plan.root,
          target: PortablePath.make("/app"),
          readOnly: false,
          realization: "passthrough",
          excludes: [],
          includes: [],
        },
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
        storage: [{ store: "data", target: PortablePath.make("/data"), readOnly: false, subpath: "tenant" }],
      },
    ],
    ["healthcheck", { healthcheck: { kind: "none", intervalSeconds: 10, timeoutSeconds: 5, retries: 3 } }],
    ["exposed port", { endpoints: [{ _tag: "internal", port: 8080, protocol: "tcp" }] }],
    ["host alias", { hostAliases: [{ hostname: "gateway", ip: "192.0.2.1" }] }],
    ["user labels", { extensions: { compose: { labels: { role: "web" } } } }],
    ["host config knob", { extensions: { compose: { privileged: true } } }],
    ["top-level knob", { extensions: { compose: { stop_signal: "SIGQUIT" } } }],
    ["query knob", { extensions: { compose: { platform: "linux/arm64" } } }],
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

  test("normalizes owned session overlays but preserves authored environment and mounts", () => {
    // Given an apply-time overlay absent from the durable desired plan.
    const overlay: ServicePlan = {
      ...service,
      environment: {
        ...service.environment,
        LANDO_HOST_IP: "192.0.2.9",
        LANDO_HOST_PROXY_SESSION: "session-1",
        LANDO_HOST_PROXY_TOKEN: "token-1",
        LANDO_HOST_PROXY_URL: "http://gateway:32001",
        LANDO_HOST_PROXY_TRANSPORT: "tcp-host-gateway",
        SSH_AUTH_SOCK: "/run/lando/ssh-agent/agent.sock",
        GNUPGHOME: "/tmp/lando-gnupg",
        LANDO_GPG_AGENT_SOCKET: "/run/lando/gpg-agent/S.gpg-agent",
        LANDO_GPG_KEYRING: "/run/lando/gpg-agent-keys",
      },
      mounts: [
        "/usr/local/bin/lando",
        "/usr/local/bin/xdg-open",
        "/usr/local/bin/open",
        "/run/lando/ssh-agent",
        "/run/lando/gpg-agent",
        "/run/lando/gpg-agent-keys",
      ].map((target) => ({
        type: "bind",
        source: "/session/one",
        target: PortablePath.make(target),
        readOnly: true,
        realization: "passthrough",
      })),
    };
    // When the label is computed for the actual overlay-bearing plan.
    const actual = fingerprint(overlay);
    // Then sessions do not cause config drift, while authored identity remains significant.
    expect(actual).toBe(fingerprint(service));
    expect(actual).toBe(
      fingerprint({
        ...overlay,
        environment: {
          ...overlay.environment,
          LANDO_HOST_PROXY_TOKEN: "token-2",
          LANDO_HOST_PROXY_SESSION: "session-2",
          LANDO_HOST_PROXY_URL: "http://gateway:32002",
        },
        mounts: overlay.mounts.map((mount) => ({ ...mount, source: "/session/two" })),
      }),
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
    const content = renderCompose(plan, { providerId: "podman", remediation: "Retry." });
    // Then both actual output surfaces carry the same opaque label.
    expect(body).toMatchObject({ Labels: { [CREATE_CONFIG_LABEL]: fingerprint(service) } });
    expect(content).toContain(`dev.lando.create-config: "${fingerprint(service)}"`);
  });
});
