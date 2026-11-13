import { expect, test } from "bun:test";
import { sha256Hex } from "@lando/sdk/digest";
import { AppPlan } from "@lando/sdk/schema";
import { Schema } from "effect";
import {
  classifyLoweredEnvRedaction,
  planRedactionValues,
  sensitivePlanCandidates,
} from "../src/plan-values.ts";

const planWith = (environment: Readonly<Record<string, unknown>>) =>
  Schema.decodeUnknownSync(AppPlan)({
    id: "proof",
    name: "proof",
    slug: "proof",
    root: "/tmp/proof",
    provider: "test",
    services: {
      db: {
        name: "db",
        type: "test",
        provider: "test",
        primary: true,
        environment,
        mounts: [],
        endpoints: [],
        routes: [],
        dependsOn: [],
        hostAliases: [],
        metadata: { resolvedAt: "2026-10-21T00:00:00Z", source: "test", runtime: 4 },
        extensions: {},
      },
    },
    routes: [],
    stores: [],
    fileSync: [],
    metadata: { resolvedAt: "2026-10-21T00:00:00Z", source: "test", runtime: 4 },
    extensions: {},
  });

test("requires a matching current digest before classifying whole-token values", () => {
  const plan = {
    ...planWith({ DB_PASSWORD: "wordpress", API_TOKEN: "changed-token" }),
    committedLiteralDigests: [sha256Hex("wordpress"), sha256Hex("old-token")],
  };
  const values = planRedactionValues(plan);
  expect(values.wholeToken).toEqual(["wordpress"]);
  expect(values.substring).toEqual(["changed-token"]);
});

test("committed bytes retain whole-token mode under unrelated secret-named keys", () => {
  const plan = {
    ...planWith({ DB_PASSWORD: "wordpress", API_TOKEN: "wordpress" }),
    committedLiteralDigests: [sha256Hex("wordpress")],
  };
  const values = planRedactionValues(plan);
  expect(values.substring).toEqual([]);
  expect(values.wholeToken).toEqual(["wordpress"]);
  expect(values.wholeTokenValues).toEqual(new Set(["wordpress"]));
});

test("excludes descriptors and current public identities without trusting retained refs", () => {
  const plan = planWith({
    MYSQL_USER: "wp",
    MYSQL_PASSWORD: "wp",
    DB_PASSWORD: "lando",
    API_TOKEN: { _tag: "SecretRef", reference: "DB" },
  });
  const values = planRedactionValues(plan);
  expect(values.substring).toEqual([]);
  expect(values.wholeToken).toEqual([]);
  expect(values.publicValues).toEqual(new Set(["wp", "lando"]));
});

test("inventories effective tooling steps and compiled event environments by exact path", () => {
  const plan = {
    ...planWith({ DB_PASSWORD: "database-private" }),
    extensions: {
      "@lando/core/effective-tooling": {
        tasks: {
          run: {
            env: { API_TOKEN: "task-private" },
            cmds: [{ cmd: "true", env: { DB_PASSWORD: "step-private" } }],
          },
        },
      },
    },
    events: {
      "post-start": [
        {
          step: { cmd: "true", env: { API_TOKEN: "event-private" } },
          source: "project",
          sourceIndex: 0,
          status: "active",
        },
      ],
    },
  } satisfies AppPlan;
  expect([...sensitivePlanCandidates(plan)].map(({ path }) => path)).toEqual([
    ["services", "db", "environment", "DB_PASSWORD"],
    ["extensions", "@lando/core/effective-tooling", "tasks", "run", "env", "API_TOKEN"],
    ["extensions", "@lando/core/effective-tooling", "tasks", "run", "cmds", 0, "env", "DB_PASSWORD"],
    ["events", "post-start", 0, "step", "env", "API_TOKEN"],
  ]);
});

test("classifyLoweredEnvRedaction uses committed bytes under any secret-named key", () => {
  const wholeToken = new Set(["wordpress"]);
  const matched = classifyLoweredEnvRedaction({ DB_PASSWORD: "wordpress", PATH: "/usr/bin" }, { wholeToken });
  expect(matched).toEqual({ substring: [], wholeToken: ["wordpress"] });

  const differentKey = classifyLoweredEnvRedaction({ API_TOKEN: "wordpress" }, { wholeToken });
  expect(differentKey).toEqual({ substring: [], wholeToken: ["wordpress"] });

  const differentValue = classifyLoweredEnvRedaction({ DB_PASSWORD: "other-secret-value" }, { wholeToken });
  expect(differentValue).toEqual({ substring: ["other-secret-value"], wholeToken: [] });

  const mixed = classifyLoweredEnvRedaction(
    { DB_PASSWORD: "wordpress", API_TOKEN: "wordpress" },
    { wholeToken },
  );
  expect(mixed).toEqual({ substring: [], wholeToken: ["wordpress"] });
});

test("classifyLoweredEnvRedaction omits public identities", () => {
  const values = classifyLoweredEnvRedaction(
    { MYSQL_USER: "wp", MYSQL_PASSWORD: "wp", DB_PASSWORD: "lando" },
    { wholeToken: new Set(["lando"]) },
  );
  expect(values).toEqual({ substring: [], wholeToken: [] });
});

test("includes proxy URL credentials from a service environment as substring values", () => {
  const plan = planWith({
    http_proxy: "http://proxyuser:proxypass-hunter2@127.0.0.1:3128",
    DB_PASSWORD: "db-private",
  });

  const values = planRedactionValues(plan);

  expect(values.substring).toEqual(expect.arrayContaining(["proxypass-hunter2", "proxyuser", "db-private"]));
  // The inventory itself stays secret-name based; proxy keys are an additional redaction source.
  expect([...sensitivePlanCandidates(plan)].map(({ path }) => path)).not.toContainEqual([
    "services",
    "db",
    "environment",
    "http_proxy",
  ]);
});

test("classifyLoweredEnvRedaction includes proxy URL credentials for uppercase proxy keys", () => {
  const values = classifyLoweredEnvRedaction({
    HTTPS_PROXY: "http://lower-user:lower-pass@127.0.0.1:3128",
    FTP_PROXY: "ftp://ftp-user:ftp-pass@127.0.0.1:21",
  });

  expect(values.substring).toEqual(
    expect.arrayContaining(["lower-user", "lower-pass", "ftp-user", "ftp-pass"]),
  );
  expect(values.wholeToken).toEqual([]);
});

test("omits public proxy userinfo", () => {
  const values = classifyLoweredEnvRedaction(
    { ALL_PROXY: "http://proxyuser:proxypass@127.0.0.1:3128" },
    { publicValues: new Set(["proxyuser"]) },
  );

  expect(values.substring).toEqual(["proxypass"]);
});
