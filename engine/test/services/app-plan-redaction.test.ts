import { afterEach, describe, expect, test } from "bun:test";
import {
  RedactionService,
  makeRedactionService,
  resetRegisteredRedactionValuesForTesting,
} from "@lando/redaction/service";
import { override, reset } from "@lando/sdk/landofile";
import { AppPlan, ServiceName } from "@lando/sdk/schema";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Redacted, Schema } from "effect";
import { outputRegisteredTestProvider } from "../../src/testing/output-provider.ts";

import {
  collectAppPlanRedactionTokens,
  collectAuthoredRedactionTokens,
  collectLandofileRedactionTokens,
} from "../../src/services/app-plan-redaction.ts";

afterEach(resetRegisteredRedactionValuesForTesting);

test("authored collection separates env maps, sensitive leaves and non-secret metadata", () => {
  const document = {
    appEnv: { stripeSecretKey: "app-env-private" },
    appLabels: { cacheKey: "app-label-private" },
    tooling: { task: { env: { stripeSecretKey: "tool-private" } } },
    toolingDefaults: { env: override({ DB_PASS: "default-private" }) },
    services: {
      app: {
        environment: override([
          "stripeSecretKey=list-private",
          "stripeSecretKey=list-private",
          "dbPassword=pg-private",
          "PGPASSWORD=not-guessed",
          "TOKENIZERS_PARALLELISM=false",
        ]),
        labels: { buildKey: "label-private" },
        extensions: { compose: { labels: { stripeSecretKey: "compose-private" } } },
        password: override("service-private"),
        creds: { password: "credential-private", rootPassword: "root-private" },
        certs: { key: "./certs/server.key" },
        storage: [{ key: "source-code" }],
        cacheKey: "cache-id",
        buildKey: "build-id",
        defaultSecretStore: "env",
        tokenFile: "./token.txt",
        rootPassword: "structural-private",
        apiToken: "api-private",
        clientSecret: "client-private",
        removedSecret: reset(),
        commands: ["PASSWORD=not-an-env-entry"],
      },
    },
  };
  expect(collectAuthoredRedactionTokens(document)).toEqual([
    "app-env-private",
    "app-label-private",
    "tool-private",
    "default-private",
    "list-private",
    "list-private",
    "pg-private",
    "label-private",
    "compose-private",
    "service-private",
    "credential-private",
    "root-private",
    "structural-private",
    "api-private",
    "client-private",
  ]);
});

test.each([collectLandofileRedactionTokens, collectAppPlanRedactionTokens])(
  "%p recognizes camelCase names in projected env and compose labels, not concatenated ones",
  (collect) => {
    expect(
      collect({
        services: {
          app: {
            environment: {
              stripeSecretKey: "sk_test_canary",
              PGPASSWORD: "pg-private",
              MYSQL_PWD: "mysql-private",
              TOKENIZERS_PARALLELISM: "false",
            },
            extensions: { compose: { labels: { stripeSecretKey: "label-private" } } },
          },
        },
      }),
    ).toEqual(["sk_test_canary", "label-private"]);
  },
);

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
    readAppEnvironment: () =>
      Effect.sync(() => {
        reads += 1;
        return [Redacted.make(reads === 1 ? "old-container-private" : "new-container-private")];
      }),
  };
  const output = await Effect.runPromise(
    Effect.gen(function* () {
      const rendererRedactor = yield* redaction.forProfile("secrets");
      const selected = outputRegisteredTestProvider(provider, plan);
      yield* selected.exec({ app: plan.id, service: ServiceName.make("web") }, { command: ["true"] });
      yield* selected.exec({ app: plan.id, service: ServiceName.make("web") }, { command: ["true"] });
      return rendererRedactor.redactString("new-container-private");
    }).pipe(Effect.provideService(RedactionService, redaction)),
  );
  expect(reads).toBe(2);
  expect(output).toBe("[redacted]");
});

describe("app-plan redaction tokens", () => {
  test("exempts public credentials across all projected service maps", () => {
    const plan = {
      services: {
        database: {
          environment: { MARIADB_USER: "magento", MARIADB_PASSWORD: "magento", MARIADB_DATABASE: "magento" },
        },
        phpmyadmin: { environment: { PMA_PASSWORD: "magento" } },
        appserver: {
          environment: { DB_PASSWORD: "magento", API_TOKEN: "private-token" },
          extensions: { compose: { labels: { "db.password": "magento" } } },
        },
      },
    };
    expect(collectAppPlanRedactionTokens(plan)).toEqual(["private-token"]);
  });

  test("does not exempt values in an unrelated plan without a matching tuple", () => {
    expect(
      collectAppPlanRedactionTokens({
        services: {
          appserver: { environment: { DB_PASSWORD: "magento" } },
        },
      }),
    ).toEqual(["magento"]);
  });

  test.each([collectAppPlanRedactionTokens, collectLandofileRedactionTokens])(
    "%p uses authored credentials across services",
    (collect) => {
      expect(
        collect({
          services: {
            database: {
              creds: { user: "magento", password: "magento", database: "shop", rootPassword: "magento" },
            },
            appserver: { environment: { DB_PASSWORD: "magento", API_TOKEN: "private-token" } },
          },
        }),
      ).toEqual(["private-token"]);
    },
  );

  test("exempts authored credentials across the whole document without losing duplicate occurrences", () => {
    const document = {
      services: {
        appserver: {
          environment: [
            "DB_PASSWORD=magento",
            "API_TOKEN=first-private",
            "API_TOKEN=second-private",
            "API_TOKEN=first-private",
          ],
        },
        database: {
          creds: { user: "magento", password: "magento", database: "magento", rootPassword: "magento" },
        },
      },
      tooling: { task: { env: { PMA_PASSWORD: "magento" } } },
    };
    expect(collectAuthoredRedactionTokens(document)).toEqual([
      "first-private",
      "second-private",
      "first-private",
    ]);
  });

  test("recognizes env tuples in authored arrays before collecting individual occurrences", () => {
    expect(
      collectAuthoredRedactionTokens({
        services: {
          database: {
            environment: ["POSTGRES_USER=magento", "POSTGRES_PASSWORD=magento", "POSTGRES_DB=shop"],
          },
          appserver: { environment: { DB_PASSWORD: "magento" } },
        },
      }),
    ).toEqual([]);
  });

  test("does not treat arbitrary authored user/password objects as credential tuples", () => {
    expect(collectAuthoredRedactionTokens({ owner: { user: "magento", password: "magento" } })).toEqual([
      "magento",
    ]);
  });

  test.each([collectLandofileRedactionTokens, collectAuthoredRedactionTokens])(
    "%p retains distinct authored credential passwords",
    (collect) => {
      expect(
        collect({
          services: {
            database: { creds: { user: "magento", password: "magento-dev", database: "magento" } },
          },
        }),
      ).toEqual(["magento-dev"]);
    },
  );

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
