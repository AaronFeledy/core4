import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildInfoSummary, infoApp, renderInfoAppResult } from "@lando/core/cli/operations";
import { ProviderUnavailableError } from "@lando/core/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortNumber,
  type ProviderCapabilities,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/core/schema";
import { AppPlanner, LandofileService, RuntimeProviderRegistry } from "@lando/core/services";
import { TestRuntimeProvider, withScenarioContext } from "@lando/core/testing";
import { formatSummary } from "@lando/renderer/summary";
import type { InfoAppResult } from "@lando/sdk/app";
import { REDACTED, createRedactor } from "@lando/sdk/secrets";
import type { RuntimeProviderShape } from "@lando/sdk/services";
import { DateTime, Effect, Layer, Stream } from "effect";
import { emptyConfigServiceLayer } from "./agent-env-test-config.ts";
import { connections } from "./connection-fixtures";

/**
 * Regression guard: secret values MUST NOT appear in `lando info`
 * output (text or JSON). `infoApp` serializes only provider-neutral runtime
 * facts (service/status/endpoints) — never service `environment` or any resolved
 * `${secret:…}` value. This test locks that invariant so a future info JSON
 * renderer (or a serializer that starts including `environment`) cannot silently
 * leak a secret.
 */

const SECRET_VALUE = "supersecret-canary-value";

const providerId = ProviderId.make("lando");

const capabilities: ProviderCapabilities = {
  artifactBuild: false,
  artifactPull: false,
  buildSecrets: false,
  buildSsh: false,
  multiServiceApply: true,
  serviceExec: true,
  serviceInit: true,
  serviceLogs: true,
  serviceLogSources: true,
  serviceHealth: "lando",
  hostReachability: "emulated",
  sharedCrossAppNetwork: true,
  persistentStorage: true,
  bindMounts: true,
  bindMountPerformance: "native",
  copyMounts: true,
  copyOnWriteAppRoot: false,
  volumeSnapshot: "none",
  serviceFileCopy: "none",
  artifactExport: false,
  artifactImport: false,
  ephemeralMounts: false,
  hostPortPublish: "proxy",
  routeProvider: false,
  tlsCertificates: "lando",
  rootless: true,
  privilegedServices: false,
  architectureEmulation: false,
  composeSpec: "portable",
  providerExtensions: [],
};

const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-05-15T00:00:00Z"),
  source: "info-no-secret.test",
  runtime: 4 as const,
};

const postgres: ServicePlan = {
  name: ServiceName.make("postgres"),
  type: "postgres",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "postgres:16-alpine" },
  command: ["postgres"],
  // The service carries a secret-shaped value in its environment; info must
  // never serialize this. The connection is the published creds surface and
  // must emit redacted password fields only.
  environment: {
    POSTGRES_USER: "lando",
    POSTGRES_DB: "appdb",
    POSTGRES_PASSWORD: SECRET_VALUE,
    LANDO_DB_USER: "lando",
    LANDO_DB_PASSWORD: SECRET_VALUE,
    LANDO_DB_NAME: "appdb",
  },
  connection: {
    family: "postgres",
    port: PortNumber.make(5432),
    creds: { user: "lando", database: "appdb", password: { _tag: "SecretRef", reference: "DB_PASSWORD" } },
  },
  mounts: [],
  endpoints: [{ _tag: "internal", port: 5432, protocol: "tcp", name: "database" }],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};

const plan: AppPlan = {
  id: AppId.make("test-info-secret"),
  name: "test-info-secret",
  slug: "test-info-secret",
  root: AbsolutePath.make("/tmp/test-info-secret"),
  provider: providerId,
  services: { [postgres.name]: postgres },
  routes: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

const makeInfoLayer = () => {
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    id: "lando",
    displayName: "Lando Runtime Provider",
    version: "0.0.0",
    platform: "linux",
    capabilities,
    isAvailable: Effect.succeed(true),
    planSetup: () => Effect.succeed({ providerId, changes: [] }),
    setup: () => Effect.void,
    getStatus: Effect.succeed({ state: "running" as const }),
    getVersions: Effect.succeed({ provider: "0.0.0" }),
    buildArtifact: () =>
      Effect.fail(
        new ProviderUnavailableError({
          providerId: "lando",
          operation: "buildArtifact",
          message: "x",
          remediation: "Install or start the `lando` provider and confirm it can perform `buildArtifact`.",
        }),
      ),
    pullArtifact: () =>
      Effect.fail(
        new ProviderUnavailableError({
          providerId: "lando",
          operation: "pullArtifact",
          message: "x",
          remediation: "Install or start the `lando` provider and confirm it can perform `pullArtifact`.",
        }),
      ),
    removeArtifact: () => Effect.void,
    apply: () => Effect.succeed({ changed: false }),
    start: () => Effect.void,
    stop: () => Effect.void,
    restart: () => Effect.void,
    waitForExit: () => Effect.succeed({ exitCode: 0 }),
    exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    execStream: () => Stream.die("not used"),
    run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    logs: () => Stream.die("not used"),
    inspect: (target) =>
      Effect.succeed({
        app: plan.id,
        service: target.service,
        providerId,
        status: "running",
        publications: { status: "present", bindings: [] },
      }),
    list: () => Effect.succeed([]),
  };

  return Layer.mergeAll(
    Layer.succeed(
      LandofileService,
      LandofileService.of({
        discover: Effect.succeed(literalLandofile({ name: "test-info-secret", services: {} }, plan.root)),
      }),
    ).pipe(Layer.provide(emptyConfigServiceLayer)),
    Layer.succeed(AppPlanner, AppPlanner.of({ plan: () => Effect.succeed(currentTestPlan(plan)) })).pipe(
      Layer.provide(emptyConfigServiceLayer),
    ),
    Layer.succeed(
      RuntimeProviderRegistry,
      RuntimeProviderRegistry.of({
        resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
        appliedPlansFor: () => Effect.succeed([]),
        resolveAppliedPlan: () => Effect.succeed(undefined),
        list: Effect.succeed([providerId]),
        capabilities: Effect.succeed(capabilities),
        select: () => Effect.succeed(provider),
      }),
    ),
  );
};

describe("lando info never leaks secret values", () => {
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.LANDO_SECRET_DB_PASSWORD;
    process.env.LANDO_SECRET_DB_PASSWORD = SECRET_VALUE;
  });

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.LANDO_SECRET_DB_PASSWORD;
    } else {
      process.env.LANDO_SECRET_DB_PASSWORD = previous;
    }
  });

  test("neither the rendered text nor the JSON serialization contains a secret value", async () => {
    const result = await Effect.runPromise(
      infoApp().pipe(Effect.provide(emptyConfigServiceLayer), Effect.provide(makeInfoLayer())),
    );

    const text = renderInfoAppResult(result);
    const json = JSON.stringify(result);

    expect(text).not.toContain(SECRET_VALUE);
    expect(json).not.toContain(SECRET_VALUE);
    expect(json).toContain("postgres");
    const creds = result.services[0]?.creds;
    expect(creds !== undefined && "password" in creds ? creds.password : undefined).toBe(REDACTED);
  });
});

describe("lando info text does not double-wrap the redaction sentinel", () => {
  const result: InfoAppResult = {
    app: "my-app",
    services: [
      {
        app: "my-app",
        service: "mysql",
        api: 4,
        type: "mysql",
        provider: "lando",
        primary: true,
        status: "running",
        connections: connections(["tcp://mysql:3306"], "app"),
        creds: {
          user: "appuser",
          password: REDACTED,
          database: "appdb",
          rootPassword: REDACTED,
        },
      },
    ],
  };

  const assertInfoTextSentinel = (text: string): void => {
    expect(text).toContain(`password=${REDACTED}`);
    expect(text).toContain("root-password=");
    expect(text).toContain(REDACTED);
    expect(text).not.toContain("[redacted]]");
    expect(text).not.toContain("[[redacted]]");
  };

  test("plain TSV keeps password and rootPassword as [redacted] after the CLI redaction pass", () => {
    const redactor = createRedactor("secrets");
    const text = redactor.redactString(renderInfoAppResult(result));
    assertInfoTextSentinel(text);
  });

  test("decorated summary keeps password and rootPassword as [redacted] after the CLI redaction pass", () => {
    const redactor = createRedactor("secrets");
    const text = redactor.redactString(formatSummary(buildInfoSummary(result)));
    assertInfoTextSentinel(text);
  });

  test("JSON creds stay [redacted] and do not leak", () => {
    const json = JSON.stringify(result);
    expect(json).toContain(`"password":"${REDACTED}"`);
    expect(json).toContain(`"rootPassword":"${REDACTED}"`);
    expect(json).not.toContain("[redacted]]");
    expect(json).not.toContain(SECRET_VALUE);
  });
});

import { currentTestPlan, literalLandofile } from "../_support/value-contracts.ts";

// The scenario harness dispatches the real in-process CLI, so these cases cover
// the renderer boundary's redaction instead of calling a renderer directly.
setDefaultTimeout(30_000);

const writeDispatchLandofile = (dir: string, lines: ReadonlyArray<string>): Effect.Effect<void> =>
  Effect.promise(() => writeFile(join(dir, ".lando.yml"), `${lines.join("\n")}\n`));

const runInfoDispatch = (
  scenarioId: string,
  lines: ReadonlyArray<string>,
): Promise<{
  readonly human: { readonly exitCode: number; readonly stdout: string; readonly stderr: string };
  readonly json: { readonly exitCode: number; readonly stdout: string; readonly stderr: string };
}> =>
  Effect.runPromise(
    withScenarioContext({ guideId: "info-no-secret", scenarioId }, (context) =>
      Effect.gen(function* () {
        yield* writeDispatchLandofile(context.testDir, lines);
        const human = yield* context.runCli(["info"]);
        const json = yield* context.runCli(["info", "--format=json"]);
        return { human, json };
      }),
    ),
  );

const jsonResult = (
  stdout: string,
): { readonly services: ReadonlyArray<{ readonly creds?: Record<string, unknown> }> } => {
  const envelope = JSON.parse(stdout) as { readonly ok?: boolean; readonly result?: unknown };
  expect(envelope.ok).toBe(true);
  return envelope.result as {
    readonly services: ReadonlyArray<{ readonly creds?: Record<string, unknown> }>;
  };
};

describe("lando info dispatch shows a published default password", () => {
  test("keeps the default mysql password in human and JSON output", async () => {
    // Given: a mysql service whose app password defaults to the published literal.
    const { human, json } = await runInfoDispatch("default-mysql-password", [
      "name: info-default-password",
      "services:",
      "  database:",
      "    type: mysql",
    ]);

    // Then: both surfaces print the published default instead of the sentinel.
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain("password=lando");
    expect(json.exitCode).toBe(0);
    expect(jsonResult(json.stdout).services[0]?.creds?.password).toBe("lando");
  });

  test("masks a non-default authored password everywhere on the dispatch path", async () => {
    // Given
    const privateValue = "hunter2-not-default";
    const { human, json } = await runInfoDispatch("private-postgres-password", [
      "name: info-private-password",
      "services:",
      "  database:",
      "    type: postgres:16",
      "    creds:",
      "      user: app",
      "      password: hunter2-not-default",
      "      database: app",
    ]);

    // Then
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain("password=[redacted]");
    expect(json.exitCode).toBe(0);
    expect(jsonResult(json.stdout).services[0]?.creds?.password).toBe(REDACTED);
    for (const output of [human.stdout, human.stderr, json.stdout, json.stderr]) {
      expect(output).not.toContain(privateValue);
    }
  });

  test("masks a secret-reference password on the dispatch path", async () => {
    // Given
    const { human, json } = await runInfoDispatch("secret-reference-password", [
      "name: info-secret-password",
      "services:",
      "  database:",
      "    type: postgres:16",
      "    creds:",
      "      user: app",
      "      password: '${secret:DB_PASSWORD}'",
      "      database: app",
    ]);

    // Then
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain("password=[redacted]");
    expect(json.exitCode).toBe(0);
    expect(jsonResult(json.stdout).services[0]?.creds?.password).toBe(REDACTED);
  });
});
