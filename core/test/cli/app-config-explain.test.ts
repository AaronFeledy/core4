import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";

import {
  type AppConfigExplainResult,
  AppConfigExplainResultSchema,
  appConfigExplain,
  renderAppConfigExplainResult,
} from "../../src/cli/commands/app-config-explain.ts";
import { lampProducer } from "../../src/recipes/builtin/lamp/snapshot.ts";

const PRODUCER_YAML = (overrides: Partial<typeof lampProducer> = {}): string => {
  const producer = { ...lampProducer, ...overrides };
  return [
    "  producer:",
    `    contentDigest: ${producer.contentDigest}`,
    `    manifestVersion: ${producer.manifestVersion}`,
    `    packageName: "${producer.packageName}"`,
    `    recipeId: ${producer.recipeId}`,
    `    sourceKind: ${producer.sourceKind}`,
  ].join("\n");
};

interface LandofileParts {
  readonly php?: string;
  readonly appserverType?: string;
  readonly extra?: string;
  readonly serviceName?: string;
  readonly recipeBlock?: string;
}

/**
 * A Landofile shaped exactly like the one `lando init --recipe=lamp` writes:
 * object provenance plus `{{ recipe.<option> }}` sites at every option-derived
 * value. Producer coordinates come from the published snapshot so the fixture
 * cannot drift away from the shipped recipe.
 */
const landofile = (parts: LandofileParts = {}): string => {
  const service = parts.serviceName ?? "appserver";
  const recipeBlock =
    parts.recipeBlock ??
    [
      "recipe:",
      "  id: lamp",
      "  options:",
      '    composer: "2"',
      "    database: mariadb:11.4",
      "    name: explain-demo",
      `    php: "${parts.php ?? "8.3"}"`,
      "    webroot: /app",
      PRODUCER_YAML(),
      `  version: ${lampProducer.manifestVersion}`,
    ].join("\n");
  return [
    "name: explain-demo",
    recipeBlock,
    "runtime: 4",
    "services:",
    `  ${service}:`,
    '    composer: "{{ recipe.composer }}"',
    "    dependsOn:",
    "      - database",
    "    framework: none",
    "    port: 80",
    `    type: "${parts.appserverType ?? "php:{{ recipe.php }}"}"`,
    '    webroot: "{{ recipe.webroot }}"',
    "  database:",
    '    type: "{{ recipe.database }}"',
    parts.extra ?? "",
  ]
    .filter((line) => line.length > 0)
    .join("\n")
    .concat("\n");
};

const withApp = async <A>(
  content: string | undefined,
  run: (cwd: string) => Promise<A>,
  options: { readonly fileName?: string } = {},
): Promise<A> => {
  const cwd = mkdtempSync(join(tmpdir(), "lando-explain-"));
  try {
    if (content !== undefined) writeFileSync(join(cwd, options.fileName ?? ".lando.yml"), content);
    return await run(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
};

const explain = (cwd: string): Promise<AppConfigExplainResult> =>
  Effect.runPromise(appConfigExplain({ cwd }));

const optionNamed = (result: AppConfigExplainResult, name: string) => {
  const option = result.options.find((entry) => entry.name === name);
  if (option === undefined) throw new Error(`no reported option "${name}"`);
  return option;
};

const blockedReason = (result: AppConfigExplainResult): string =>
  result.comparison.status === "blocked" ? result.comparison.reason : "matched";

describe("appConfigExplain", () => {
  it("matches a bundled recipe and reports every managed site", async () => {
    await withApp(landofile(), async (cwd) => {
      const result = await explain(cwd);
      expect(result.form).toBe("declarative");
      expect(result.comparison).toEqual({
        status: "matched",
        snapshotVersion: lampProducer.manifestVersion,
      });
      expect(result.recipe?.id).toBe("lamp");
      expect(result.recipe?.producer).toEqual(lampProducer);

      const php = optionNamed(result, "php");
      expect(php.value).toBe("8.3");
      expect(php.default).toBe("8.3");
      expect(php.status).toBe("accepted-by-value");
      expect(php.references.map((site) => site.path)).toEqual(["services.appserver.type"]);
      expect(php.takenOver).toEqual([]);

      expect(optionNamed(result, "webroot").references.map((site) => site.path)).toEqual([
        "services.appserver.webroot",
      ]);
      expect(optionNamed(result, "database").references.map((site) => site.path)).toEqual([
        "services.database.type",
      ]);
      expect(result.options.every((option) => option.takenOver.length === 0)).toBe(true);
    });
  });

  it("labels a nondefault option value chosen-by-value", async () => {
    await withApp(landofile({ php: "8.2" }), async (cwd) => {
      const result = await explain(cwd);
      expect(optionNamed(result, "php").status).toBe("chosen-by-value");
      expect(optionNamed(result, "composer").status).toBe("accepted-by-value");
    });
  });

  it("reports an option with no published default as chosen-by-value", async () => {
    await withApp(landofile(), async (cwd) => {
      const name = optionNamed(await explain(cwd), "name");
      expect(name.default).toBeUndefined();
      expect(name.status).toBe("chosen-by-value");
    });
  });

  it("labels a literal replacement of a generated site taken over", async () => {
    await withApp(landofile({ appserverType: "php:8.3" }), async (cwd) => {
      const php = optionNamed(await explain(cwd), "php");
      expect(php.takenOver).toEqual([
        {
          path: "services.appserver.type",
          generatedExpression: "php:{{ recipe.php }}",
          currentValue: '"php:8.3"',
        },
      ]);
      expect(php.references).toEqual([]);
    });
  });

  it("labels a composite site with a changed constant taken over even though it still references the option", async () => {
    await withApp(landofile({ appserverType: "php-fpm:{{ recipe.php }}" }), async (cwd) => {
      const result = await explain(cwd);
      const php = optionNamed(result, "php");
      expect(php.takenOver.map((site) => site.path)).toEqual(["services.appserver.type"]);
      // The reference is still a bounded current fact even though the site is taken over.
      expect(php.references.map((site) => site.path)).toEqual(["services.appserver.type"]);
    });
  });

  it("applies a service rename map before matching generated paths", async () => {
    const renamed = landofile({
      serviceName: "web",
      recipeBlock: [
        "recipe:",
        "  id: lamp",
        "  options:",
        '    composer: "2"',
        "    database: mariadb:11.4",
        "    name: explain-demo",
        '    php: "8.3"',
        "    webroot: /app",
        PRODUCER_YAML(),
        "  services:",
        "    appserver: web",
        `  version: ${lampProducer.manifestVersion}`,
      ].join("\n"),
    });
    await withApp(renamed, async (cwd) => {
      const result = await explain(cwd);
      expect(result.comparison.status).toBe("matched");
      expect(result.services).toEqual([{ generated: "appserver", current: "web" }]);
      expect(optionNamed(result, "php").takenOver).toEqual([]);
      expect(optionNamed(result, "php").references.map((site) => site.path)).toEqual(["services.web.type"]);
    });
  });

  it("blocks a service map naming an unknown generated service", async () => {
    const bogus = landofile({
      recipeBlock: [
        "recipe:",
        "  id: lamp",
        "  options:",
        '    php: "8.3"',
        PRODUCER_YAML(),
        "  services:",
        "    nope: web",
        `  version: ${lampProducer.manifestVersion}`,
      ].join("\n"),
    });
    await withApp(bogus, async (cwd) => {
      const result = await explain(cwd);
      expect(blockedReason(result)).toBe("invalid-service-map");
      expect(optionNamed(result, "php").references.length).toBeGreaterThan(0);
    });
  });

  it("blocks a non-injective service map", async () => {
    const collide = landofile({
      recipeBlock: [
        "recipe:",
        "  id: lamp",
        "  options:",
        '    php: "8.3"',
        PRODUCER_YAML(),
        "  services:",
        "    appserver: web",
        "    database: web",
        `  version: ${lampProducer.manifestVersion}`,
      ].join("\n"),
    });
    await withApp(collide, async (cwd) => {
      const result = await explain(cwd);
      expect(blockedReason(result)).toBe("invalid-service-map");
      expect(result.recipe?.producer).toEqual(lampProducer);
      expect(optionNamed(result, "php").value).toBe("8.3");
    });
  });

  it("blocks a rename that collides with an implicit identity mapping", async () => {
    const collide = landofile({
      recipeBlock: [
        "recipe:",
        "  id: lamp",
        "  options:",
        '    php: "8.3"',
        PRODUCER_YAML(),
        "  services:",
        "    appserver: database",
        `  version: ${lampProducer.manifestVersion}`,
      ].join("\n"),
    });
    await withApp(collide, async (cwd) => {
      const result = await explain(cwd);
      expect(blockedReason(result)).toBe("invalid-service-map");
      expect(optionNamed(result, "php").value).toBe("8.3");
    });
  });

  it("blocks bare provenance but still reports current expression references", async () => {
    await withApp(landofile({ recipeBlock: "recipe: lamp" }), async (cwd) => {
      const result = await explain(cwd);
      expect(result.form).toBe("bare");
      expect(blockedReason(result)).toBe("bare-provenance");
      expect(result.recipe?.id).toBe("lamp");
      expect(optionNamed(result, "php").references.map((site) => site.path)).toEqual([
        "services.appserver.type",
      ]);
      expect(result.options.every((option) => option.status === undefined)).toBe(true);
      expect(result.options.every((option) => option.default === undefined)).toBe(true);
    });
  });

  it("blocks a Landofile with no recipe provenance", async () => {
    await withApp("name: plain\nruntime: 4\n", async (cwd) => {
      const result = await explain(cwd);
      expect(result.form).toBe("absent");
      expect(blockedReason(result)).toBe("no-recipe");
      expect(result.options).toEqual([]);
    });
  });

  it("blocks an unknown recipe id", async () => {
    const unknown = landofile({
      recipeBlock: [
        "recipe:",
        "  id: nonesuch",
        "  options:",
        '    php: "8.3"',
        PRODUCER_YAML({ recipeId: "nonesuch", packageName: "@lando/recipe-nonesuch" }),
        `  version: ${lampProducer.manifestVersion}`,
      ].join("\n"),
    });
    await withApp(unknown, async (cwd) => {
      const result = await explain(cwd);
      expect(blockedReason(result)).toBe("unknown-recipe");
      expect(optionNamed(result, "php").value).toBe("8.3");
      expect(optionNamed(result, "php").default).toBeUndefined();
    });
  });

  it("blocks provenance recorded against a different producer version", async () => {
    const older = landofile({
      recipeBlock: [
        "recipe:",
        "  id: lamp",
        "  options:",
        '    php: "8.3"',
        PRODUCER_YAML({ manifestVersion: "0.0.1" }),
        "  version: 0.0.1",
      ].join("\n"),
    });
    await withApp(older, async (cwd) => {
      const result = await explain(cwd);
      expect(blockedReason(result)).toBe("identity-mismatch");
      expect(result.recipe?.version).toBe("0.0.1");
      expect(optionNamed(result, "php").references.length).toBeGreaterThan(0);
    });
  });

  it("blocks a Landofile that carries includes", async () => {
    await withApp(landofile({ extra: "includes:\n  - ./extra.yml" }), async (cwd) => {
      const result = await explain(cwd);
      expect(blockedReason(result)).toBe("includes-present");
      expect(optionNamed(result, "php").references.length).toBeGreaterThan(0);
      expect(optionNamed(result, "php").takenOver).toEqual([]);
    });
  });

  it("blocks a programmatic Landofile without executing it", async () => {
    await withApp(
      'throw new Error("app:config:explain must never execute .lando.ts");\n',
      async (cwd) => {
        const result = await explain(cwd);
        expect(result.form).toBe("programmatic");
        expect(blockedReason(result)).toBe("programmatic-landofile");
        expect(result.options).toEqual([]);
      },
      { fileName: ".lando.ts" },
    );
  });

  it("blocks a dual-form Landofile while still reporting YAML facts", async () => {
    await withApp(landofile(), async (cwd) => {
      writeFileSync(
        join(cwd, ".lando.ts"),
        'throw new Error("app:config:explain must never execute .lando.ts");\n',
      );
      const result = await explain(cwd);
      expect(result.form).toBe("declarative");
      expect(blockedReason(result)).toBe("programmatic-landofile");
      expect(result.recipe?.producer).toEqual(lampProducer);
      expect(optionNamed(result, "php").value).toBe("8.3");
      expect(optionNamed(result, "php").takenOver).toEqual([]);
    });
  });

  it("fails with LandofileNotFoundError when no Landofile is in scope", async () => {
    await withApp(undefined, async (cwd) => {
      const exit = await Effect.runPromise(Effect.either(appConfigExplain({ cwd })));
      expect(exit._tag).toBe("Left");
      if (exit._tag === "Left") expect(exit.left._tag).toBe("LandofileNotFoundError");
    });
  });

  it("never rewrites the Landofile it reads", async () => {
    await withApp(landofile(), async (cwd) => {
      const path = join(cwd, ".lando.yml");
      const before = await Bun.file(path).text();
      await explain(cwd);
      expect(await Bun.file(path).text()).toBe(before);
    });
  });

  it("decodes and renders through the published result schema", async () => {
    await withApp(landofile({ php: "8.2", appserverType: "php:8.2" }), async (cwd) => {
      const result = await explain(cwd);
      const decoded = Schema.decodeUnknownSync(AppConfigExplainResultSchema)(
        JSON.parse(JSON.stringify(Schema.encodeSync(AppConfigExplainResultSchema)(result))),
      );
      expect(decoded.comparison.status).toBe("matched");

      const text = renderAppConfigExplainResult(result);
      expect(text).toContain("Recipe: lamp");
      expect(text).toContain("chosen-by-value");
      expect(text).toContain("taken over");
    });
  });

  it("renders a blocked report with its remediation", async () => {
    await withApp(landofile({ recipeBlock: "recipe: lamp" }), async (cwd) => {
      const text = renderAppConfigExplainResult(await explain(cwd));
      expect(text).toContain("blocked");
      expect(text).toContain("bare-provenance");
    });
  });
});
