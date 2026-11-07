import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LANDOFILE_LOAD_POLICY } from "@lando/landofile/load-expression-file";
import { loadLandofileFile } from "@lando/landofile/service";
import { planRedactionValues } from "@lando/redaction/plan-values";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { sha256Hex } from "@lando/sdk/digest";
import { override, reset } from "@lando/sdk/landofile";
import { AbsolutePath, AppPlan, ServiceName } from "@lando/sdk/schema";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Redacted, Schema } from "effect";
import {
  type LandofileRedactionValues,
  collectAuthoredRedactionTokens,
  collectAuthoredRedactionTokens as collectLandofileRedactionTokens,
  registerLandofileRedaction,
} from "../../src/services/app-plan-redaction.ts";
import { registerPlanRedaction } from "../../src/services/plan-redaction.ts";
import { outputRegisteredTestProvider } from "../../src/testing/output-provider.ts";

const planMeta = { resolvedAt: "2026-10-21T00:00:00Z", source: "test", runtime: 4 } as const;

test.each([collectLandofileRedactionTokens, collectAuthoredRedactionTokens])(
  "collects weak secret env keys in tooling steps and events (%#)",
  (collect) => {
    const values = collect({
      tooling: { check: { cmds: [{ cmd: "true", env: { DB_PASS: "step-private" } }] } },
      events: { "pre-start": [{ cmd: "true", env: { DB_PASS: "event-private" } }] },
    });
    expect(new Set(values.substring)).toEqual(new Set(["step-private", "event-private"]));
  },
);

const planService = (
  name: string,
  extra: {
    readonly environment?: Readonly<Record<string, unknown>>;
    readonly extensions?: Readonly<Record<string, unknown>>;
    readonly connection?: {
      readonly family: "mysql" | "mariadb" | "postgres" | "mongodb" | "mssql";
      readonly port: number;
      readonly creds: {
        readonly user: string;
        readonly password: string;
        readonly database: string;
        readonly rootPassword?: string;
      };
    };
    readonly primary?: boolean;
  } = {},
) => ({
  name,
  type: "test",
  provider: "test",
  primary: extra.primary ?? (name === "app" || name === "appserver" || name === "database" || name === "db"),
  environment: extra.environment ?? {},
  mounts: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata: planMeta,
  extensions: extra.extensions ?? {},
  ...(extra.connection === undefined ? {} : { connection: extra.connection }),
});

const decodePlan = (
  services: Readonly<Record<string, ReturnType<typeof planService>>>,
  committedLiteralDigests?: AppPlan["committedLiteralDigests"],
) =>
  Schema.decodeUnknownSync(AppPlan)({
    id: "proof",
    name: "proof",
    slug: "proof",
    root: "/tmp/proof",
    provider: "test",
    services,
    routes: [],
    stores: [],
    fileSync: [],
    metadata: planMeta,
    extensions: {},
    ...(committedLiteralDigests === undefined ? {} : { committedLiteralDigests }),
  });

const allTokens = (values: LandofileRedactionValues): readonly string[] => [
  ...values.substring,
  ...values.wholeToken,
];

const expectTokens = (values: LandofileRedactionValues, expected: readonly string[]) => {
  expect([...allTokens(values)].sort()).toEqual([...expected].sort());
};

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
  expectTokens(collectAuthoredRedactionTokens(document), [
    "app-env-private",
    "app-label-private",
    "tool-private",
    "default-private",
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
  // Without occurrence proof every token is substring.
  expect(collectAuthoredRedactionTokens(document).wholeToken).toEqual([]);
});

test("landofile collection recognizes camelCase names in projected env and compose labels, not concatenated ones", () => {
  expect(
    allTokens(
      collectLandofileRedactionTokens({
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
    ),
  ).toEqual(["sk_test_canary", "label-private"]);
});

test("plan collection recognizes camelCase names in projected env and compose labels, not concatenated ones", () => {
  expect(
    planRedactionValues(
      decodePlan({
        app: planService("app", {
          environment: {
            stripeSecretKey: "sk_test_canary",
            PGPASSWORD: "pg-private",
            MYSQL_PWD: "mysql-private",
            TOKENIZERS_PARALLELISM: "false",
          },
          extensions: { compose: { labels: { stripeSecretKey: "label-private" } } },
        }),
      }),
    ).substring,
  ).toEqual(["sk_test_canary", "label-private"]);
});

test("retained invocations read current containers again instead of caching registration", async () => {
  const plan = Schema.decodeUnknownSync(AppPlan)({
    id: "retained-output",
    name: "retained-output",
    slug: "retained-output",
    root: "/tmp/retained-output",
    provider: "test",
    services: { web: planService("web", {}) },
    routes: [],
    stores: [],
    fileSync: [],
    metadata: { resolvedAt: "2026-10-21T00:00:00Z", source: "test", runtime: 4 },
    extensions: {},
  });
  const redaction = makeRedactionService();
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
      yield* Effect.scoped(provider.apply(plan, { reconcile: true }));
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
    const values = planRedactionValues(
      decodePlan({
        database: planService("database", {
          environment: {
            MARIADB_USER: "magento",
            MARIADB_PASSWORD: "magento",
            MARIADB_DATABASE: "magento",
          },
        }),
        phpmyadmin: planService("phpmyadmin", {
          primary: false,
          environment: { PMA_PASSWORD: "magento" },
        }),
        appserver: planService("appserver", {
          environment: { DB_PASSWORD: "magento", API_TOKEN: "private-token" },
          extensions: { compose: { labels: { "db.password": "magento" } } },
        }),
      }),
    );
    expect(values.substring).toEqual(["private-token"]);
    expect(values.publicValues.has("magento")).toBe(true);
  });

  test("does not exempt values in an unrelated plan without a matching tuple", () => {
    expect(
      planRedactionValues(
        decodePlan({
          appserver: planService("appserver", { environment: { DB_PASSWORD: "magento" } }),
        }),
      ).substring,
    ).toEqual(["magento"]);
  });

  test("plan uses connection credentials across services", () => {
    expect(
      planRedactionValues(
        decodePlan({
          database: planService("database", {
            connection: {
              family: "mariadb",
              port: 3306,
              creds: { user: "magento", password: "magento", database: "shop", rootPassword: "magento" },
            },
          }),
          appserver: planService("appserver", {
            environment: { DB_PASSWORD: "magento", API_TOKEN: "private-token" },
          }),
        }),
      ).substring,
    ).toEqual(["private-token"]);
  });

  test("landofile uses authored credentials across services", () => {
    expect(
      allTokens(
        collectLandofileRedactionTokens({
          services: {
            database: {
              creds: { user: "magento", password: "magento", database: "shop", rootPassword: "magento" },
            },
            appserver: { environment: { DB_PASSWORD: "magento", API_TOKEN: "private-token" } },
          },
        }),
      ),
    ).toEqual(["private-token"]);
  });

  test("exempts authored credentials across the whole document without losing private tokens", () => {
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
    expectTokens(collectAuthoredRedactionTokens(document), ["first-private", "second-private"]);
  });

  test("recognizes env tuples in authored arrays before collecting individual occurrences", () => {
    expectTokens(
      collectAuthoredRedactionTokens({
        services: {
          database: {
            environment: ["POSTGRES_USER=magento", "POSTGRES_PASSWORD=magento", "POSTGRES_DB=shop"],
          },
          appserver: { environment: { DB_PASSWORD: "magento" } },
        },
      }),
      [],
    );
  });

  test("does not treat arbitrary authored user/password objects as credential tuples", () => {
    expectTokens(collectAuthoredRedactionTokens({ owner: { user: "magento", password: "magento" } }), [
      "magento",
    ]);
  });

  test.each([
    { creds: { user: "private-canary", password: "private-canary" } },
    ["MYSQL_USER=private-canary", "MYSQL_PASSWORD=private-canary"],
    { environment: { MYSQL_USER: "private-canary", MYSQL_PASSWORD: "private-canary" } },
  ])("unrelated authored objects cannot exempt service passwords: %j", (unrelated) => {
    const values = collectAuthoredRedactionTokens({
      "x-unrelated": unrelated,
      services: { web: { environment: { DB_PASSWORD: "private-canary" } } },
    });
    expect(values.substring).toContain("private-canary");
    expect(values.publicValues.has("private-canary")).toBe(false);
  });

  test.each([
    (input: Parameters<typeof collectLandofileRedactionTokens>[0]) =>
      allTokens(collectLandofileRedactionTokens(input)),
    (input: unknown) => allTokens(collectAuthoredRedactionTokens(input)),
  ])("%p retains distinct authored credential passwords", (collect) => {
    expect(
      collect({
        services: {
          database: { creds: { user: "magento", password: "magento-dev", database: "magento" } },
        },
      }),
    ).toEqual(["magento-dev"]);
  });

  test("excludes published default credentials while collecting custom plan passwords", () => {
    const values = planRedactionValues(
      decodePlan({
        database: planService("database", {
          environment: { MYSQL_PASSWORD: "lando", MYSQL_ROOT_PASSWORD: "lando" },
        }),
        storage: planService("storage", {
          primary: false,
          environment: { MINIO_ROOT_PASSWORD: "landolando" },
        }),
        custom: planService("custom", {
          primary: false,
          environment: { DB_PASSWORD: "private-plan-password" },
        }),
      }),
    );
    expect(values.substring).toEqual(["private-plan-password"]);
  });

  test("excludes published defaults from authored passwords, labels, and tooling environment", () => {
    // Given
    const landofile = {
      services: { database: { password: "lando", labels: { "db.password": "landolando" } } },
      tooling: { task: { env: { DB_PASSWORD: "lando" } } },
      toolingDefaults: { env: { API_SECRET: "landolando", CUSTOM_PASSWORD: "private-tooling-password" } },
    };
    // When
    const tokens = allTokens(collectLandofileRedactionTokens(landofile));
    // Then
    expect(tokens).toEqual(["private-tooling-password"]);
  });

  test("includes secret service environment values from an app plan", () => {
    const canary = "env-file-json-canary";
    expect(
      planRedactionValues(decodePlan({ app: planService("app", { environment: { DB_PASSWORD: canary } }) }))
        .substring,
    ).toContain(canary);
  });

  test("includes secret global app defaults after planner projection", () => {
    const canary = "global-app-default-canary";
    expect(
      planRedactionValues(decodePlan({ app: planService("app", { environment: { API_TOKEN: canary } }) }))
        .substring,
    ).toContain(canary);
  });

  test("includes secret effective service label values from an app plan", () => {
    const canary = "effective-label-canary";
    expect(
      planRedactionValues(
        decodePlan({
          app: planService("app", {
            extensions: { compose: { labels: { "com.example.api-token": canary } } },
          }),
        }),
      ).substring,
    ).toContain(canary);
  });

  test("includes dotted secret label values while keeping non-secret labels visible", () => {
    const dotted = "dotted-effective-label-canary";
    const hyphenated = "hyphenated-effective-label-canary";
    const visible = "dotted-visible-label-canary";
    const values = planRedactionValues(
      decodePlan({
        app: planService("app", {
          extensions: {
            compose: {
              labels: {
                "com.example.password": dotted,
                "dev.example.db-password": hyphenated,
                "com.example.team": visible,
              },
            },
          },
        }),
      }),
    );
    expect(values.substring).toContain(dotted);
    expect(values.substring).toContain(hyphenated);
    expect(values.substring).not.toContain(visible);
  });

  test("classifies digest-bound authored literals as whole-token and unproven secrets as substring", () => {
    const values = planRedactionValues(
      decodePlan(
        {
          db: planService("db", {
            environment: { DB_PASSWORD: "wordpress", API_TOKEN: "substring-private" },
          }),
        },
        [sha256Hex("wordpress")],
      ),
    );
    expect(values.wholeToken).toEqual(["wordpress"]);
    expect(values.substring).toEqual(["substring-private"]);
  });

  test("registerPlanRedaction installs both tiers on the live registry", async () => {
    const plan = decodePlan(
      {
        db: planService("db", {
          environment: { DB_PASSWORD: "wordpress", API_TOKEN: "substring-private" },
        }),
      },
      [sha256Hex("wordpress")],
    );
    const redaction = makeRedactionService();
    const redacted = await Effect.runPromise(
      Effect.gen(function* () {
        yield* registerPlanRedaction(plan);
        const redactor = yield* redaction.forProfile("secrets");
        return {
          bare: redactor.redactString("PASSWORD=wordpress"),
          packageName: redactor.redactString("wp-content/plugins/wordpress-seo"),
          substring: redactor.redactString("prefix-substring-private-suffix"),
        };
      }).pipe(Effect.provideService(RedactionService, redaction)),
    );
    expect(redacted.bare).toBe("PASSWORD=[redacted]");
    expect(redacted.packageName).toBe("wp-content/plugins/wordpress-seo");
    expect(redacted.substring).toBe("prefix-[redacted]-suffix");
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
    const tokens = allTokens(collectLandofileRedactionTokens(landofile));

    // Then
    expect(tokens).toContain(canary);
  });

  test("includes dotted secret landofile label values while keeping non-secret labels visible", () => {
    // Given
    const dotted = "dotted-landofile-label-canary";
    const hyphenated = "hyphenated-landofile-label-canary";
    const visible = "dotted-visible-landofile-label-canary";

    // When
    const tokens = allTokens(
      collectLandofileRedactionTokens({
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
      }),
    );

    // Then
    expect(tokens).toContain(dotted);
    expect(tokens).toContain(hyphenated);
    expect(tokens).not.toContain(visible);
  });
});

describe("landofile redaction tiers", () => {
  test("unproven landofile and authored values stay substring", () => {
    const landofile = {
      services: {
        db: {
          environment: { DB_PASSWORD: "wordpress" },
          creds: { password: "wordpress" },
        },
      },
      appEnv: { API_TOKEN: "app-env-token" },
    };
    const landofileValues = collectLandofileRedactionTokens(landofile);
    expect(landofileValues.substring).toEqual(expect.arrayContaining(["wordpress"]));
    expect(landofileValues.wholeToken).toEqual([]);

    const authored = collectAuthoredRedactionTokens({
      ...landofile,
      appEnv: { API_TOKEN: "app-env-token" },
    });
    expect(authored.substring).toEqual(expect.arrayContaining(["wordpress", "app-env-token"]));
    expect(authored.wholeToken).toEqual([]);
  });

  test("registerLandofileRedaction keeps whole-token off the substring registry", async () => {
    const redaction = makeRedactionService();
    await Effect.runPromise(
      registerLandofileRedaction({
        substring: ["substring-secret"],
        wholeToken: ["wordpress"],
        publicValues: new Set(),
      }).pipe(Effect.provideService(RedactionService, redaction)),
    );
    const redactor = await Effect.runPromise(
      redaction.forProfile("secrets").pipe(Effect.provideService(RedactionService, redaction)),
    );
    expect(redactor.redactString("prefix-substring-secret-suffix")).toBe("prefix-[redacted]-suffix");
    expect(redactor.redactString("wordpress-seo")).toBe("wordpress-seo");
    expect(redactor.redactString("PASSWORD=wordpress")).toBe("PASSWORD=[redacted]");
  });
});

test("canonical authored Landofile password is whole-token; local overlay stays substring", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-landofile-tiers-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      "name: tiers\nservices:\n  db:\n    environment:\n      DB_PASSWORD: wordpress\n      API_TOKEN: canonical-token\n",
    );
    const canonical = await Effect.runPromise(
      loadLandofileFile(join(root, ".lando.yml"), {
        appRoot: root,
        layer: "canonical",
        policy: DEFAULT_LANDOFILE_LOAD_POLICY,
        pendingSites: [],
        compilationContext: { appRoot: AbsolutePath.make(root), env: {} },
      }),
    );
    const canonicalValues = collectLandofileRedactionTokens(canonical.document);
    expect(canonicalValues.wholeToken).toEqual(expect.arrayContaining(["wordpress", "canonical-token"]));
    expect(canonicalValues.substring).not.toEqual(expect.arrayContaining(["wordpress"]));

    const localRoot = await mkdtemp(join(tmpdir(), "lando-landofile-local-"));
    try {
      await writeFile(
        join(localRoot, ".lando.local.yml"),
        "services:\n  db:\n    environment:\n      DB_PASSWORD: local-wordpress\n",
      );
      // load as local layer alone
      const local = await Effect.runPromise(
        loadLandofileFile(join(localRoot, ".lando.local.yml"), {
          appRoot: localRoot,
          layer: "local",
          policy: DEFAULT_LANDOFILE_LOAD_POLICY,
          pendingSites: [],
          compilationContext: { appRoot: AbsolutePath.make(localRoot), env: {} },
        }),
      );
      const localValues = collectLandofileRedactionTokens(local.document);
      expect(localValues.wholeToken).toEqual([]);
      expect(localValues.substring).toContain("local-wordpress");
    } finally {
      await rm(localRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
