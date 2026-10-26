import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityError } from "@lando/sdk/errors";
import { type ProviderCapabilities, ProviderId } from "@lando/sdk/schema";
import { AppPlanner, PluginRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Result } from "effect";
import { appConfigLint } from "../../src/operations/app-config-lint.ts";
import { assertAuthoredNetworksSupported } from "../../src/planner/compose-capabilities.ts";
import * as Plugins from "../../src/plugins/registry.ts";
import { lintLandofileSnapshot } from "../../src/services/landofile-live.ts";
import * as Planner from "../../src/services/planner.ts";

const lint = (root: string, capabilities: ProviderCapabilities | undefined) =>
  Effect.runPromise(
    Effect.flatMap(PluginRegistry, (registry) =>
      appConfigLint({ cwd: root }).pipe(
        Effect.provideService(PluginRegistry, {
          ...registry,
          declaredProviderCapabilities: () => capabilities,
        }),
      ),
    ).pipe(Effect.provide(Plugins.layer)),
  );

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
    const snapshot = await Effect.runPromise(lintLandofileSnapshot({ cwd: root }));
    if (snapshot.resolved === undefined) throw new Error("Expected a resolved lint snapshot");
    const landofile = snapshot.resolved;
    const planned = await Effect.runPromise(
      Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, capabilities)).pipe(
        Effect.result,
        Effect.provide(Planner.layer),
        Effect.provide(Plugins.layer),
      ),
    );
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
