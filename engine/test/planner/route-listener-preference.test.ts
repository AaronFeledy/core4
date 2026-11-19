import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LandofileShape, ServiceName } from "@lando/sdk/schema";
import { PluginRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { emitYamlDocument } from "@lando/sdk/yaml";
import { Effect, Schema } from "effect";
import { appConfigLint } from "../../src/operations/app-config-lint.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import { planAppPlannerCerts } from "../services/app-planner-certs-harness.ts";

const lint = (root: string) =>
  Effect.runPromise(
    Effect.flatMap(PluginRegistry, (registry) =>
      appConfigLint({ cwd: root }).pipe(
        Effect.provideService(PluginRegistry, {
          ...registry,
          declaredProviderCapabilities: () => TestRuntimeProvider.capabilities,
        }),
      ),
    ).pipe(Effect.provide(PluginRegistryLayer.layer)),
  );

const dualListenerDocument = (certs?: boolean) => ({
  name: "listener-preference",
  runtime: 4,
  services: {
    web: {
      type: "node:22",
      ...(certs === undefined ? {} : { certs }),
      endpoints: [
        { kind: "internal", protocol: "http", port: 80, name: "web", primary: true },
        { kind: "internal", protocol: "https", port: 443, name: "web-https" },
      ],
      routes: ["plain.lndo.site"],
    },
  },
});

const planOn = async (root: string, certs?: boolean) => {
  const document = dualListenerDocument(certs);
  await mkdir(join(root, "app"), { recursive: true });
  return planAppPlannerCerts({
    appRoot: join(root, "app"),
    cacheRoot: join(root, "cache"),
    landofile: Schema.decodeUnknownSync(LandofileShape)(document),
  });
};

test("keeps generated Apache native TLS on the HTTPS listener with a verified backend", async () => {
  // Given: a stock php/apache service whose default HTTPS route demands the certificate.
  const root = await mkdtemp(join(tmpdir(), "lando-router-preference-apache-"));
  try {
    await mkdir(join(root, "app"), { recursive: true });
    // When
    const plan = await planAppPlannerCerts({
      appRoot: join(root, "app"),
      cacheRoot: join(root, "cache"),
      landofile: Schema.decodeUnknownSync(LandofileShape)({
        name: "apache-preference",
        runtime: 4,
        services: { web: { type: "php:8.3" } },
      }),
    });
    // Then
    expect(plan.services[ServiceName.make("web")]?.certs?.caId).toBe("mkcert");
    expect(plan.routes).toHaveLength(1);
    expect(plan.routes[0]).toMatchObject({
      scheme: "https",
      backend: { protocol: "https", port: 443, tls: { caId: "mkcert" } },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lint and planning bind the plain primary when the service holds no generated certificate", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-router-preference-plain-"));
  try {
    await writeFile(join(root, ".lando.yml"), emitYamlDocument(dualListenerDocument()));
    // When
    const linted = await lint(root);
    const plan = await planOn(root);
    // Then: the HTTPS route binds the primary, so lint has no route finding and the plan agrees.
    expect(linted.violations.filter(({ rule }) => rule === "landofile.route")).toEqual([]);
    expect(plan.routes[0]?.backend).toMatchObject({ protocol: "http", port: 80 });
    expect(plan.routes[0]?.backend.tls).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lint and planning bind the HTTPS listener when the service holds a generated certificate", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-router-preference-cert-"));
  try {
    await writeFile(join(root, ".lando.yml"), emitYamlDocument(dualListenerDocument(true)));
    // When
    const linted = await lint(root);
    const plan = await planOn(root, true);
    // Then
    expect(linted.violations.filter(({ rule }) => rule === "landofile.route")).toEqual([]);
    expect(plan.routes[0]?.backend).toMatchObject({
      protocol: "https",
      port: 443,
      tls: { caId: "mkcert" },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
