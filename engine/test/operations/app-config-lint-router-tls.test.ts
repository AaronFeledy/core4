import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { emitYamlDocument } from "@lando/sdk/yaml";
import { Effect, Layer } from "effect";
import { appConfigLint } from "../../src/operations/app-config-lint.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";

const RULE = "service.router-tls-termination";
const capabilities = { ...TestRuntimeProvider.capabilities, artifactBuild: true };

const lint = (root: string) =>
  Effect.runPromise(
    Effect.flatMap(PluginRegistry, (registry) =>
      appConfigLint({
        cwd: root,
        templates: { modules: [], context: { env: {}, scope: "test", bootstrapLevel: "minimal" } },
      }).pipe(
        Effect.provideService(PluginRegistry, {
          ...registry,
          declaredProviderCapabilities: () => capabilities,
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(PluginRegistryLayer.layer, BunFileSystem.layer))),
  );

const withApp = async (
  document: unknown,
  run: (root: string, result: Awaited<ReturnType<typeof lint>>) => void,
) => {
  const root = await mkdtemp(join(tmpdir(), "lando-router-tls-lint-"));
  try {
    await writeFile(join(root, ".lando.yml"), emitYamlDocument(document));
    const result = await lint(root);
    run(root, result);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const php = (config: Record<string, unknown>) => ({
  name: "router-tls",
  services: { web: { type: "php:8.3", ...config } },
});

test("does not infer default HTTPS intent when the service's proxy entry failed to load", async () => {
  await withApp({ ...php({ certs: false }), proxy: { web: ["{{ env.ROUTE }}"] } }, (_root, result) => {
    expect(result.valid).toBe(false);
    expect(result.violations.map(({ rule, path }) => [rule, path])).toEqual([
      ["landofile.load", ["proxy", "web", 0]],
    ]);
  });
});

test("warns when certs: false leaves generated Apache terminating TLS at the router", async () => {
  await withApp(php({ certs: false }), (_root, result) => {
    expect(result.valid).toBe(true);
    const findings = result.violations.filter(({ rule }) => rule === RULE);
    expect(findings).toEqual([
      expect.objectContaining({
        rule: RULE,
        severity: "warning",
        path: ["services", "web", "certs"],
        suggestion: expect.stringContaining("Remove certs: false"),
      }),
    ]);
    expect(findings[0]?.message).toContain("web");
    expect(findings[0]?.message).toContain("certs: false");
    expect(findings[0]?.message).toContain("HTTPS=on");
    expect(findings[0]?.message).toContain("%{HTTPS}");
    expect(findings[0]?.message).toContain("RewriteCond %{HTTPS} off");
  });
});

test("warns when custom certificate material keeps Apache from serving native TLS", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-router-tls-custom-"));
  try {
    await mkdir(join(root, "certs"), { recursive: true });
    await writeFile(join(root, "certs", "site.crt"), "custom certificate\n");
    await writeFile(join(root, "certs", "site.key"), "custom key\n");
    await writeFile(
      join(root, ".lando.yml"),
      emitYamlDocument(php({ certs: { cert: "certs/site.crt", key: "certs/site.key" } })),
    );
    const result = await lint(root);
    expect(result.valid).toBe(true);
    const findings = result.violations.filter(({ rule }) => rule === RULE);
    expect(findings).toEqual([
      expect.objectContaining({
        rule: RULE,
        path: ["services", "web", "certs"],
        suggestion: expect.stringContaining("Use certs: true"),
      }),
    ]);
    expect(findings[0]?.message).toContain("custom certificate material");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("warns when a non-root user: keeps Apache's parent from reading the generated key", async () => {
  await withApp(php({ user: "www-data" }), (_root, result) => {
    expect(result.valid).toBe(true);
    const findings = result.violations.filter(({ rule }) => rule === RULE);
    expect(findings).toEqual([
      expect.objectContaining({
        rule: RULE,
        path: ["services", "web", "user"],
        suggestion: expect.stringContaining("Remove the authored user:"),
      }),
    ]);
    expect(findings[0]?.message).toContain("non-root user:");
  });
});

test.each([
  { label: "generated certificate", config: { certs: true } },
  {
    label: "explicit plain-listener selector",
    config: { certs: false, routes: [{ hostname: "app.lndo.site", endpoint: 80 }] },
  },
  {
    label: "HTTP-only route",
    config: { certs: false, routes: [{ hostname: "app.lndo.site", scheme: "http" }] },
  },
  { label: "explicitly empty route list", config: { certs: false, routes: [] } },
])("stays silent for $label", async ({ config }) => {
  await withApp(php(config), (_root, result) => {
    expect(result.violations.filter(({ rule }) => rule === RULE)).toEqual([]);
  });
});

test("stays silent when the router is disabled", async () => {
  await withApp({ ...php({ certs: false }), router: { enabled: false } }, (_root, result) => {
    expect(result.violations.filter(({ rule }) => rule === RULE)).toEqual([]);
  });
});
