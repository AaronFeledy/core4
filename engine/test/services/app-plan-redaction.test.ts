import { afterEach, describe, expect, test } from "bun:test";
import {
  RedactionService,
  makeRedactionService,
  resetRegisteredRedactionValuesForTesting,
} from "@lando/redaction/service";
import { AppPlan } from "@lando/sdk/schema";
import { AppOutputRedaction } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Redacted, Schema } from "effect";
import {
  layer as appOutputRedactionLayer,
  registerAppOutputRedaction,
} from "../../src/services/app-output-redaction.ts";

import {
  collectAppPlanRedactionTokens,
  collectLandofileRedactionTokens,
} from "../../src/services/app-plan-redaction.ts";

afterEach(resetRegisteredRedactionValuesForTesting);

test("retained invocations read current containers again instead of caching registration", async () => {
  resetRegisteredRedactionValuesForTesting();
  const plan = Schema.decodeUnknownSync(AppPlan)({
    id: "retained-output",
    name: "retained-output",
    slug: "retained-output",
    root: "/tmp/retained-output",
    provider: "test",
    services: {},
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    metadata: { resolvedAt: "2026-10-21T00:00:00Z", source: "test", runtime: 4 },
    extensions: {},
  });
  const redaction = makeRedactionService({
    id: "empty",
    list: Effect.succeed([]),
    get: () => Effect.die("No store resolution expected"),
    has: () => Effect.succeed(false),
  });
  let reads = 0;
  const provider = {
    ...TestRuntimeProvider,
    readAppSecrets: () =>
      Effect.sync(() => {
        reads += 1;
        return [Redacted.make(reads === 1 ? "old-container-private" : "new-container-private")];
      }),
  };
  const output = await Effect.runPromise(
    Effect.gen(function* () {
      const rendererRedactor = yield* redaction.forProfile("secrets");
      const pluginPort = yield* AppOutputRedaction;
      yield* pluginPort.register(plan, provider);
      yield* registerAppOutputRedaction({ plan, provider });
      return rendererRedactor.redactString("new-container-private");
    }).pipe(Effect.provideService(RedactionService, redaction), Effect.provide(appOutputRedactionLayer)),
  );
  expect(reads).toBe(2);
  expect(output).toBe("[redacted]");
});

describe("app-plan redaction tokens", () => {
  test("excludes published default credentials while collecting custom plan passwords", () => {
    // Given
    const plan = {
      services: {
        database: { environment: { MYSQL_PASSWORD: "lando", MYSQL_ROOT_PASSWORD: "lando" } },
        storage: { environment: { MINIO_ROOT_PASSWORD: "landolando" } },
        custom: { environment: { DB_PASSWORD: "private-plan-password" } },
      },
    };
    // When
    const tokens = collectAppPlanRedactionTokens(plan);
    // Then
    expect(tokens).toEqual(["private-plan-password"]);
  });

  test("excludes published defaults from authored passwords, labels, and tooling environment", () => {
    // Given
    const landofile = {
      services: { database: { password: "lando", labels: { "db.password": "landolando" } } },
      tooling: { task: { env: { DB_PASSWORD: "lando" } } },
      toolingDefaults: { env: { API_SECRET: "landolando", CUSTOM_PASSWORD: "private-tooling-password" } },
    };
    // When
    const tokens = collectLandofileRedactionTokens(landofile);
    // Then
    expect(tokens).toEqual(["private-tooling-password"]);
  });

  test("includes secret service environment values from an app plan", () => {
    // Given
    const canary = "env-file-json-canary";

    // When
    const tokens = collectAppPlanRedactionTokens({
      services: {
        app: {
          environment: { DB_PASSWORD: canary },
        },
      },
    });

    // Then
    expect(tokens).toContain(canary);
  });

  test("includes secret global app defaults after planner projection", () => {
    const canary = "global-app-default-canary";

    const tokens = collectAppPlanRedactionTokens({
      services: {
        app: {
          environment: { API_TOKEN: canary },
        },
      },
    });

    expect(tokens).toContain(canary);
  });

  test("includes secret effective service label values from an app plan", () => {
    // Given
    const canary = "effective-label-canary";

    // When
    const tokens = collectAppPlanRedactionTokens({
      services: {
        app: {
          environment: {},
          extensions: { compose: { labels: { "com.example.api-token": canary } } },
        },
      },
    });

    // Then
    expect(tokens).toContain(canary);
  });

  test("includes dotted secret label values while keeping non-secret labels visible", () => {
    // Given
    const dotted = "dotted-effective-label-canary";
    const hyphenated = "hyphenated-effective-label-canary";
    const visible = "dotted-visible-label-canary";

    // When
    const tokens = collectAppPlanRedactionTokens({
      services: {
        app: {
          environment: {},
          extensions: {
            compose: {
              labels: {
                "com.example.password": dotted,
                "dev.example.db-password": hyphenated,
                "com.example.team": visible,
              },
            },
          },
        },
      },
    });

    // Then
    expect(tokens).toContain(dotted);
    expect(tokens).toContain(hyphenated);
    expect(tokens).not.toContain(visible);
  });

  test("includes authored landofile environment values", () => {
    // Given
    const canary = "config-canary";
    const landofile = {
      services: {
        app: {
          environment: { PASSWORD: canary },
        },
      },
    };

    // When
    const tokens = collectLandofileRedactionTokens(landofile);

    // Then
    expect(tokens).toContain(canary);
  });

  test("includes dotted secret landofile label values while keeping non-secret labels visible", () => {
    // Given
    const dotted = "dotted-landofile-label-canary";
    const hyphenated = "hyphenated-landofile-label-canary";
    const visible = "dotted-visible-landofile-label-canary";

    // When
    const tokens = collectLandofileRedactionTokens({
      services: {
        app: {
          environment: {},
          labels: {
            "com.example.password": dotted,
            "dev.example.db-password": hyphenated,
            "com.example.team": visible,
          },
        },
      },
    });

    // Then
    expect(tokens).toContain(dotted);
    expect(tokens).toContain(hyphenated);
    expect(tokens).not.toContain(visible);
  });
});
