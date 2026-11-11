import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LANDOFILE_LOAD_POLICY } from "@lando/landofile/load-expression-file";
import { loadLandofileFile, loadLandofileLayers } from "@lando/landofile/service";
import { planRedactionValues } from "@lando/redaction/plan-values";
import { createStandaloneRedactor } from "@lando/redaction/service";
import { sha256Hex } from "@lando/sdk/digest";
import { AbsolutePath, GlobalConfig, ServiceName } from "@lando/sdk/schema";
import { AppPlanner, ConfigService } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Schema } from "effect";
import * as PlanCache from "../../src/cache/app-plan.ts";
import * as Cache from "../../src/cache/service.ts";
import { effectiveToolingForPlan } from "../../src/planner/effective-tooling.ts";
import * as Registry from "../../src/plugins/registry.ts";
import * as FileSystem from "../../src/services/file-system.ts";
import * as Planner from "../../src/services/planner.ts";

const withRoot = async (run: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "lando-plan-literal-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const runPlan = (
  root: string,
  options: {
    readonly ts?: boolean;
    readonly layers?: boolean;
    readonly appEnv?: Record<string, string>;
    readonly cache?: boolean;
  } = {},
) => {
  const file = join(root, options.ts ? ".lando.ts" : ".lando.yml");
  const config = Schema.decodeUnknownSync(GlobalConfig)({ appEnv: options.appEnv ?? {} });
  return Effect.runPromise(
    Effect.gen(function* () {
      const loaded = yield* options.layers
        ? loadLandofileLayers(root, file)
        : loadLandofileFile(file, {
            appRoot: root,
            layer: "canonical",
            policy: DEFAULT_LANDOFILE_LOAD_POLICY,
            pendingSites: [],
            compilationContext: { appRoot: AbsolutePath.make(root), env: { PROOF_PASSWORD: "wordpress" } },
          });
      return yield* (yield* AppPlanner).plan(loaded, TestRuntimeProvider.capabilities);
    }).pipe(
      Effect.provide(
        Planner.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              FileSystem.layer,
              Registry.layer,
              Layer.succeed(ConfigService, {
                load: Effect.succeed(config),
                get: (key) => Effect.succeed(config[key]),
              }),
              options.cache ? Cache.layer : Layer.empty,
            ),
          ),
        ),
      ),
    ),
  );
};

const database = (password: string, rootPassword = true) =>
  `name: proof\nservices:\n  db:\n    type: mariadb\n    home: false\n    creds:\n      user: wp\n      database: app\n${rootPassword ? "      rootPassword: lando\n" : ""}      password: ${JSON.stringify(password)}\n`;

test.each([
  ["redis", "redis-cli", "REDISCLI_AUTH"],
  ["mariadb", "mariadb", "MYSQL_PWD"],
  ["mysql", "mysql", "MYSQL_PWD"],
  ["postgres", "psql", "PGPASSWORD"],
  ["mssql", "sqlcmd", "SQLCMDPASSWORD"],
] as const)("proves owned %s service and client password projections", (type, task, key) =>
  withRoot(async (root) => {
    await writeFile(
      join(root, ".lando.yml"),
      type === "redis"
        ? "name: proof\nservices:\n  db:\n    type: redis\n    home: false\n    creds:\n      password: wordpress\n"
        : type === "mssql"
          ? "name: proof\nservices:\n  db:\n    type: mssql\n    home: false\n    creds:\n      user: sa\n      database: app\n      password: wordpress\n"
          : database("wordpress", type === "mysql" || type === "mariadb").replace(
              "type: mariadb",
              `type: ${type}`,
            ),
    );
    const plan = await runPlan(root);
    expect(effectiveToolingForPlan(plan)?.[task]?.env?.[key]).toBe("wordpress");
    expect(planRedactionValues(plan).wholeToken).toEqual(["wordpress"]);
    expect(planRedactionValues(plan).substring).toEqual([]);
    expect(plan.committedLiteralDigests).toEqual(
      (type === "mysql" || type === "mariadb" ? ["lando", "wordpress"] : ["wordpress"]).map(sha256Hex).sort(),
    );
  }),
);

test.each([
  "tooling:\n  redis-cli:\n    service: db\n    cmd: redis-cli\n    env:\n      REDISCLI_AUTH: wordpress\n",
  "services:\n  db:\n    environment:\n      API_TOKEN: wordpress\n",
])("propagates committed Redis bytes to unrelated local occurrences: %s", (local) =>
  withRoot(async (root) => {
    await writeFile(
      join(root, ".lando.yml"),
      "name: proof\nservices:\n  db:\n    type: redis\n    home: false\n    creds:\n      password: wordpress\n",
    );
    await writeFile(join(root, ".lando.local.yml"), local);
    const plan = await runPlan(root, { layers: true });
    expect(planRedactionValues(plan).substring).toEqual([]);
    expect(planRedactionValues(plan).wholeToken).toEqual(["wordpress"]);
  }),
);

test("generated mongosh URI protects an encoded authored password without collecting public identities", () =>
  withRoot(async (root) => {
    await writeFile(
      join(root, ".lando.yml"),
      database("p!ss", false).replace("type: mariadb", "type: mongodb"),
    );
    const plan = await runPlan(root);
    const values = planRedactionValues(plan);
    const uri = effectiveToolingForPlan(plan)?.mongosh?.env?.MONGO_URI;
    if (typeof uri !== "string") throw new TypeError("Expected literal Mongo URI");
    const redactor = createStandaloneRedactor("secrets", {
      redactionTokens: values.substring,
      wholeTokenValues: values.wholeToken,
    });
    expect(values.substring).toEqual([]);
    expect(values.wholeToken).toEqual(["p!ss"]);
    expect(uri).toContain("p%21ss");
    const safe = redactor.redactString(uri);
    expect(safe).not.toContain("p%21ss");
    expect(redactor.redactString("wp app 127.0.0.1")).toBe("wp app 127.0.0.1");
    expect(safe).toContain("@127.0.0.1:");
    expect(safe).toContain("/app");
  }));

test("proves canonical credential projections and exact cross-service copies, not embedded expressions", () =>
  withRoot(async (root) => {
    await writeFile(
      join(root, ".lando.yml"),
      database("wordpress") +
        [
          "  web:",
          "    type: lando",
          "    image: alpine:3",
          "    home: false",
          "    environment:",
          '      DB_PASSWORD: "{{ services.db.creds.password }}"',
          '      API_TOKEN: "prefix-{{ services.db.creds.password }}"',
        ].join("\n"),
    );
    const plan = await runPlan(root);
    expect(plan.committedLiteralDigests).toEqual([sha256Hex("lando"), sha256Hex("wordpress")].sort());
    expect(plan.services[ServiceName.make("web")]?.environment.DB_PASSWORD).toBe("wordpress");
    expect(planRedactionValues(plan).substring).toEqual(["prefix-wordpress"]);
    expect(planRedactionValues(plan).wholeToken).toEqual(["wordpress"]);
  }));

test.each(["local", "shadow", "env_file", "appEnv", "env", "load", "typescript"] as const)(
  "keeps %s-only passwords substring-sensitive despite unrelated equal literals",
  (source) =>
    withRoot(async (root) => {
      let yaml = "name: wordpress\nservices:\n  db:\n    type: lando\n    image: alpine:3\n    home: false\n";
      if (source === "local" || source === "shadow") {
        yaml =
          source === "shadow"
            ? database("wordpress")
            : "name: proof\nservices:\n  db:\n    type: mariadb\n    home: false\n";
        await writeFile(
          join(root, ".lando.local.yml"),
          "services:\n  db:\n    creds:\n      user: wp\n      database: app\n      rootPassword: lando\n      password: wordpress\n",
        );
      }
      if (source === "env_file") {
        yaml += "    env_file: password.env\n";
        await writeFile(join(root, "password.env"), "MYSQL_PASSWORD=wordpress\n");
      }
      if (source === "env" || source === "load") {
        yaml = database(source === "env" ? "{{ env.PROOF_PASSWORD }}" : "{{ load('./password.txt') }}");
        await writeFile(join(root, "password.txt"), "wordpress");
      }
      if (source === "typescript")
        await writeFile(
          join(root, ".lando.ts"),
          'export default {name:"wordpress",services:{db:{type:"mariadb",home:false,creds:{user:"wp",database:"app",rootPassword:"lando",password:"wordpress"}}}};',
        );
      else await writeFile(join(root, ".lando.yml"), yaml);
      const plan = await runPlan(root, {
        ts: source === "typescript",
        layers: source === "local" || source === "shadow",
        appEnv: source === "appEnv" ? { MYSQL_PASSWORD: "wordpress" } : {},
      });
      expect(plan.committedLiteralDigests ?? []).not.toContain(sha256Hex("wordpress"));
      expect(planRedactionValues(plan).substring).toContain("wordpress");
      expect(planRedactionValues(plan).wholeToken).toEqual([]);
    }),
);

test("committed Redis environment bytes prove matching credentials from another layer", () =>
  withRoot(async (root) => {
    await writeFile(
      join(root, ".lando.yml"),
      "name: proof\nservices:\n  db:\n    type: redis\n    home: false\n    environment:\n      REDISCLI_AUTH: wordpress\n",
    );
    await writeFile(
      join(root, ".lando.local.yml"),
      "services:\n  db:\n    creds:\n      password: wordpress\n",
    );
    const values = planRedactionValues(await runPlan(root, { layers: true }));
    expect(values.substring).toEqual([]);
    expect(values.wholeToken).toEqual(["wordpress"]);
  }));

test("proves authored native password aliases and fails closed after value mutation", () =>
  withRoot(async (root) => {
    await writeFile(
      join(root, ".lando.yml"),
      "name: proof\nservices:\n  db:\n    type: postgres\n    home: false\n    environment:\n      POSTGRES_PASSWORD: mail\n",
    );
    const plan = await runPlan(root);
    expect(planRedactionValues(plan).wholeToken).toEqual(["mail"]);
    const name = ServiceName.make("db");
    const db = plan.services[name];
    if (db === undefined) throw new TypeError("Missing db");
    const mutated = {
      ...plan,
      services: {
        ...plan.services,
        [name]: { ...db, environment: { ...db.environment, POSTGRES_PASSWORD: "changed-password" } },
      },
    };
    expect(planRedactionValues(mutated).substring).toContain("changed-password");
  }));

test.each(["${secret:DB}", "lando", "wp"])("does not collect deferred or public password %s", (password) =>
  withRoot(async (root) => {
    await writeFile(join(root, ".lando.yml"), database(password));
    const values = planRedactionValues(await runPlan(root));
    expect(values.substring).toEqual([]);
    expect(values.wholeToken).toEqual([]);
    if (password !== "${secret:DB}") expect(values.publicValues.has(password)).toBe(true);
  }),
);

test("recomputes committed digests on the cache-hit path", () =>
  withRoot(async (root) => {
    await writeFile(join(root, ".lando.yml"), database("wordpress"));
    const fresh = await runPlan(root);
    const lookup = spyOn(PlanCache, "readCachedAppPlan").mockReturnValue(
      Effect.succeed({ ...fresh, committedLiteralDigests: [] }),
    );
    try {
      const cached = await runPlan(root, { cache: true });
      expect(lookup).toHaveBeenCalled();
      expect(cached.committedLiteralDigests).toEqual(fresh.committedLiteralDigests);
    } finally {
      lookup.mockRestore();
    }
  }));

test("matches the existing substring inventory on an unannotated representative plan", () =>
  withRoot(async (root) => {
    await writeFile(
      join(root, ".lando.yml"),
      "name: proof\nservices:\n  web:\n    type: lando\n    image: alpine:3\n    home: false\n    environment:\n      DB_PASSWORD: wordpress\n      MYSQL_PASSWORD: public-user\n      MYSQL_USER: public-user\n      API_TOKEN: private-token\n    labels:\n      example.password: label-private\n",
    );
    const { committedLiteralDigests: _digests, ...plan } = await runPlan(root);
    expect(new Set(planRedactionValues(plan).substring)).toEqual(
      new Set(["wordpress", "private-token", "label-private"]),
    );
    expect(planRedactionValues(plan).wholeToken).toEqual([]);
  }));

test("proves tooling defaults, steps, project events, and their exact credential copies", () =>
  withRoot(async (root) => {
    await writeFile(
      join(root, ".lando.yml"),
      database("wordpress") +
        [
          "toolingDefaults:",
          "  env:",
          "    DEFAULT_TOKEN: default-private",
          "tooling:",
          "  check:",
          "    cmd: echo",
          "    env:",
          '      DB_PASSWORD: "{{ services.db.creds.password }}"',
          "    cmds:",
          "      - cmd: echo",
          "        env:",
          "          STEP_TOKEN: step-private",
          "events:",
          "  post-start:",
          "    - cmd: echo",
          "      env:",
          "        EVENT_TOKEN: event-private",
        ].join("\n"),
    );
    const plan = await runPlan(root);
    expect(plan.committedLiteralDigests).toEqual(
      ["lando", "wordpress", "default-private", "step-private", "event-private"].map(sha256Hex).sort(),
    );
  }));

test("committed tooling default bytes propagate to an expression override", () =>
  withRoot(async (root) => {
    await writeFile(
      join(root, ".lando.yml"),
      [
        "name: proof",
        "toolingDefaults:",
        "  env:",
        "    API_TOKEN: wordpress",
        "tooling:",
        "  check:",
        "    cmd: echo",
        "    env:",
        '      API_TOKEN: "{{ env.PROOF_PASSWORD }}"',
      ].join("\n"),
    );
    const plan = await runPlan(root);
    expect(plan.committedLiteralDigests).toEqual([sha256Hex("wordpress")]);
    expect(planRedactionValues(plan).wholeToken).toEqual(["wordpress"]);
  }));
