import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityError } from "@lando/sdk/errors";
import { type ProviderCapabilities, ProviderId } from "@lando/sdk/schema";
import { AppPlanner, PluginRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Result } from "effect";
import { loadUserLandofileFile } from "../../src/landofile/app-resolution.ts";
import { appConfigLint } from "../../src/operations/app-config-lint.ts";
import { assertAuthoredNetworksSupported } from "../../src/planner/compose-capabilities.ts";
import * as Plugins from "../../src/plugins/registry.ts";
import { lintLandofileSnapshot } from "../../src/services/landofile-live.ts";
import * as Planner from "../../src/services/planner.ts";

type DeclaredCapabilities = (id: ProviderId) => ProviderCapabilities | undefined;

const declared = (
  capabilities: ProviderCapabilities | undefined | DeclaredCapabilities,
): DeclaredCapabilities => (typeof capabilities === "function" ? capabilities : () => capabilities);

const lint = (root: string, capabilities: ProviderCapabilities | undefined | DeclaredCapabilities) =>
  Effect.runPromise(
    Effect.flatMap(PluginRegistry, (registry) =>
      appConfigLint({ cwd: root }).pipe(
        Effect.provideService(PluginRegistry, {
          ...registry,
          declaredProviderCapabilities: declared(capabilities),
        }),
      ),
    ).pipe(Effect.provide(Plugins.layer)),
  );

// Plans with the same declared provider capabilities that lint saw.
const planWith = (root: string, selected: ProviderCapabilities, capabilities: DeclaredCapabilities) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const snapshot = yield* lintLandofileSnapshot({ cwd: root });
      if (snapshot.resolved === undefined) throw new Error("Expected a resolved lint snapshot");
      const landofile = snapshot.resolved;
      const registry = yield* PluginRegistry;
      return yield* Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, selected)).pipe(
        Effect.provide(
          Planner.layer.pipe(
            Layer.provide(
              Layer.succeed(PluginRegistry, { ...registry, declaredProviderCapabilities: capabilities }),
            ),
          ),
        ),
        Effect.result,
      );
    }).pipe(Effect.provide(Plugins.layer)),
  );

test.each([
  ["node", undefined, false],
  ["node", false, true],
  ["node", true, false],
  ["compose", undefined, true],
  ["compose", true, false],
  ["compose", false, true],
] as const)("lint admits %s init=%s without support: %s", async (type, init, valid) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-init-lint-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      `name: initlint\nservices:\n  web:\n    type: ${type === "node" ? "node:22" : type}\n    image: node:22-alpine\n    home: false\n    appMount: false\n${init === undefined ? "" : `    init: ${init}\n`}`,
    );
    // When
    const result = await lint(root, { ...TestRuntimeProvider.capabilities, serviceInit: false });
    // Then
    expect(result.valid).toBe(valid);
    const findings = result.violations.filter((issue) => issue.path.join(".") === "services.web.init");
    expect(findings.map((issue) => issue.severity)).toEqual(
      init === undefined ? (type === "node" ? ["warning", "error"] : ["warning"]) : valid ? [] : ["error"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  "ipv4_address",
  "ipv6_address",
  "link_local_ips",
  "mac_address",
  "driver_opts",
  "priority",
  "gw_priority",
  "interface_name",
])("lint rejects network attachment %s with field-specific remediation", async (field) => {
  const root = await mkdtemp(join(tmpdir(), "lando-network-rejection-"));
  try {
    const value = field === "link_local_ips" ? "[169.254.1.1]" : field === "driver_opts" ? "{}" : "1";
    await writeFile(
      join(root, ".lando.yml"),
      `name: rejectnetwork\nservices:\n  web:\n    type: compose\n    image: alpine\n    networks:\n      default:\n        ${field}: ${value}\n`,
    );
    const result = await lint(root, TestRuntimeProvider.capabilities);
    const finding = result.violations.find(
      (issue) => issue.path.join(".") === `services.web.networks.default.${field}`,
    );
    expect(result.valid).toBe(false);
    expect(finding?.severity).toBe("error");
    expect(finding?.suggestion).toContain(`Remove networks.*.${field}`);
    expect(finding?.suggestion).toContain("alias");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lint reports all unsupported Compose fields using planner remediation and source paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-capability-lint-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      'name: caplint\nservices:\n  web:\n    type: compose\n    image: alpine\n    home: false\n    privileged: true\n    read_only: true\n    profiles: [dev]\n    healthcheck:\n      test: [CMD, "true"]\n      start_interval: 1s\nsecrets:\n  token:\n    file: token.txt\n',
    );
    const capabilities = { ...TestRuntimeProvider.capabilities, composeKnobs: { supported: [] } };
    const result = await lint(root, capabilities);
    const findings = result.violations.filter((issue) => issue.rule === "landofile.capability");
    expect(result.valid).toBe(false);
    expect(findings.map((issue) => issue.path.join(".")).sort()).toEqual([
      "secrets",
      "services.web.healthcheck.start_interval",
      "services.web.privileged",
      "services.web.profiles",
      "services.web.read_only",
    ]);
    const planned = await planWith(root, capabilities, () => capabilities);
    expect(Result.isFailure(planned)).toBe(true);
    if (Result.isFailure(planned)) expect(planned.failure._tag).toBe("CapabilityError");
    if (Result.isFailure(planned) && planned.failure._tag === "CapabilityError") {
      expect(findings.find((issue) => issue.path.at(-1) === "privileged")?.suggestion).toBe(
        planned.failure.remediation,
      );
    }
    expect(
      findings.every(
        (issue) => issue.severity === "error" && issue.suggestion !== undefined && issue.source !== undefined,
      ),
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lint warns rather than failing when provider capabilities cannot be resolved offline", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-capability-warning-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      "name: capwarning\nprovider: missing\nservices:\n  web:\n    type: compose\n    image: alpine\n",
    );
    const result = await lint(root, undefined);
    expect(result.valid).toBe(true);
    expect(result.violations).toMatchObject([
      { rule: "landofile.capability", severity: "warning", path: ["provider"] },
    ]);
    expect(result.violations[0]?.message).toContain("lando start");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([false, true])(
  "lint and planning reject authored networks (bridge aliases=%s)",
  async (bridgeAliases) => {
    const root = await mkdtemp(join(tmpdir(), "lando-network-capability-lint-"));
    try {
      await writeFile(
        join(root, ".lando.yml"),
        bridgeAliases
          ? "name: capnetwork\nservices:\n  web:\n    type: compose\n    image: alpine\n    networks:\n      default:\n        aliases: [api]\n"
          : "name: capnetwork\nnetworks:\n  peer:\n    external: true\nservices:\n  web:\n    type: compose\n    image: alpine\n    networks: [peer]\n",
      );
      const { authoredNetworks: _authoredNetworks, ...capabilities } = TestRuntimeProvider.capabilities;
      const result = await lint(root, capabilities);
      const planned = await Effect.runPromise(
        assertAuthoredNetworksSupported(
          ProviderId.make("lando"),
          capabilities,
          bridgeAliases
            ? { perAppBridge: { name: "lando-capnetwork", aliases: {} } }
            : {
                perAppBridge: null,
                authoredNetworks: [{ key: "peer", name: "peer", external: true, members: {} }],
              },
        ).pipe(Effect.result),
      );
      expect(result.valid).toBe(false);
      if (!Result.isFailure(planned)) throw new Error("Expected capability failure");
      const error: CapabilityError = planned.failure;
      expect(result.violations.find((issue) => issue.rule === "landofile.capability")?.suggestion).toBe(
        error.remediation,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

const withoutKnobs = { ...TestRuntimeProvider.capabilities, composeKnobs: { supported: [] } };

test.each([
  [
    "names installed providers that declare the knob",
    { ...TestRuntimeProvider.capabilities, composeKnobs: { supported: ["gpus" as const] } },
    [],
    "Remove gpus from service web, or use a provider that supports it: docker (`lando setup --provider=docker`).",
  ],
  [
    "offers only removal when no installed provider declares the knob",
    withoutKnobs,
    [],
    "Remove gpus from service web.",
  ],
  [
    "names the selected provider's extension namespaces",
    withoutKnobs,
    ["compose"],
    "Remove gpus from service web, or move the intent under providers.compose.",
  ],
])("lint and planning remediation %s", async (_name, docker, providerExtensions, remediation) => {
  // Given a selected provider without the knob, and an installed docker provider.
  const root = await mkdtemp(join(tmpdir(), "lando-knob-remediation-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      "name: knobfix\nprovider: lando\nservices:\n  web:\n    type: compose\n    image: alpine\n    home: false\n    gpus: all\n",
    );
    const selected = { ...withoutKnobs, providerExtensions };
    const capabilities: DeclaredCapabilities = (id) => (id === "docker" ? docker : selected);

    // When
    const result = await lint(root, capabilities);
    const planned = await planWith(root, selected, capabilities);

    // Then
    const finding = result.violations.find((issue) => issue.path.join(".") === "services.web.gpus");
    expect(finding?.suggestion).toBe(remediation);
    if (!Result.isFailure(planned) || planned.failure._tag !== "CapabilityError")
      throw new Error("Expected a capability failure");
    expect(planned.failure.remediation).toBe(remediation);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["always", "never"])(
  "lint and planning reject pull_policy: %s without artifact pull",
  async (policy) => {
    // Given a provider that cannot pull service images.
    const root = await mkdtemp(join(tmpdir(), "lando-pull-policy-lint-"));
    try {
      await writeFile(
        join(root, ".lando.yml"),
        `name: pullfix\nservices:\n  web:\n    type: compose\n    image: alpine\n    home: false\n    pull_policy: ${policy}\n`,
      );
      const capabilities = { ...TestRuntimeProvider.capabilities, artifactPull: false };

      // When
      const result = await lint(root, capabilities);
      const planned = await planWith(root, capabilities, () => capabilities);

      // Then
      const finding = result.violations.find((issue) => issue.path.join(".") === "services.web.pull_policy");
      expect(result.valid).toBe(false);
      expect(finding?.severity).toBe("error");
      if (!Result.isFailure(planned) || planned.failure._tag !== "CapabilityError")
        throw new Error("Expected a capability failure");
      expect(planned.failure.capability).toBe("artifactPull");
      expect(finding?.suggestion).toBe(planned.failure.remediation);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each([
  ["limits.cpus", "cpus: 1e308"],
  ["limits.cpus", 'cpus: "half"'],
  ["limits.pids", 'pids: "9007199254740993"'],
  ["limits.memory", "memory: -1"],
])("lint and planning reject an unrepresentable deploy.resources.%s (%s)", async (field, line) => {
  // Given a resource value past the container engine's integer range.
  const root = await mkdtemp(join(tmpdir(), "lando-resource-range-lint-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      `name: rangefix\nservices:\n  web:\n    type: compose\n    image: alpine\n    home: false\n    deploy:\n      resources:\n        limits:\n          ${line}\n`,
    );

    // When
    const result = await lint(root, TestRuntimeProvider.capabilities);
    const loaded = await Effect.runPromise(
      loadUserLandofileFile(join(root, ".lando.yml")).pipe(Effect.result, Effect.provide(Plugins.layer)),
    );

    // Then
    const path = `services.web.deploy.resources.${field}`;
    expect(result.valid).toBe(false);
    expect(result.violations.find((issue) => issue.path.join(".") === path)?.severity).toBe("error");
    if (!Result.isFailure(loaded) || loaded.failure._tag !== "LandofileValidationError")
      throw new Error("Expected the Landofile planning loads to fail validation");
    expect(loaded.failure.issues.map((issue) => issue.path.join("."))).toContain(path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
