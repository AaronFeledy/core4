import { describe, expect, test } from "bun:test";
import { getAtPath } from "@lando/engine/config-write/dot-path";
import { selectMigrationPath } from "@lando/sdk/recipes";
import type { RecipeHunkClassification, RecipeProducer } from "@lando/sdk/schema";
import { analyzeRecipeMigration } from "../../src/cli/commands/app-config-migrate-analysis.ts";
import {
  renameAfterStateMatches,
  renameMigrationService,
} from "../../src/cli/commands/app-config-migrate-rename.ts";
import {
  conflictingSecondEdgeFixture,
  customizedOptionLandofile,
  makeMigrationFixture,
  managedLandofile,
  parseMigrationLandofile,
  partialRenameLandofile,
  renameCollisionFixture,
  renamedServiceLandofile,
  staleRenameRefsLandofile,
  takenOverLandofile,
} from "./fixtures/recipe-migrations.ts";

const inputFor = (text = managedLandofile()) => ({
  ...parseMigrationLandofile(text),
  target: makeMigrationFixture().target,
  migrations: makeMigrationFixture().migrations,
  decide: () => true,
});
type AnalyzedEdge = {
  readonly from: RecipeProducer;
  readonly to: RecipeProducer;
  readonly status: string;
  readonly hunks: ReadonlyArray<{ readonly id: string; readonly classification: RecipeHunkClassification }>;
};
/** Assert an analyzed edge is present before reading it, so an absent edge fails loudly. */
const requireEdge = (edge: AnalyzedEdge | undefined): AnalyzedEdge => {
  if (edge === undefined) throw new Error("Expected an analyzed migration edge, found none.");
  return edge;
};
const statuses = (edge: AnalyzedEdge | undefined) => requireEdge(edge).status;
const classifications = (edge: AnalyzedEdge | undefined) =>
  requireEdge(edge).hunks.map((hunk) => hunk.classification);

describe("service rename reference rewrite", () => {
  const hunk = {
    id: "rename-database",
    kind: "rename" as const,
    layer: "canonical" as const,
    path: "services.database",
    old: "services.database",
    new: "services.db",
  };

  test("rewrites a managed route service field with the new name", () => {
    // Given
    const database = { type: "{{ recipe.database }}" };
    const document = {
      services: { appserver: { depends_on: ["database"] }, database },
      routes: { "http://db.lndo.site": { service: "database" } },
      events: { "post-start": [{ service: "database" }] },
    };
    // When
    const renamed = renameMigrationService(hunk, {
      document,
      renderedOld: document,
      renderedNew: {
        services: { appserver: { depends_on: ["db"] }, db: database },
        routes: { "http://db.lndo.site": { service: "db" } },
        events: { "post-start": [{ service: "db" }] },
      },
      serviceMap: new Map(),
    });
    // Then
    expect(renamed.kind).toBe("applied");
    if (renamed.kind !== "applied") throw new Error("Expected the rename to apply.");
    expect(renamed.document).toMatchObject({
      routes: { "http://db.lndo.site": { service: "db" } },
      events: { "post-start": [{ service: "db" }] },
      services: { appserver: { depends_on: ["db"] } },
    });
  });

  const dependency = { condition: "service_started", required: false, restart: true };
  const cache = { condition: "service_healthy" };
  const database = { type: "postgres" };
  const renderedOld = { services: { appserver: { depends_on: { database: dependency, cache } }, database } };
  const renderedNew = {
    services: { appserver: { depends_on: { cache, db: dependency } }, db: database },
  };
  const context = { renderedOld, renderedNew, serviceMap: new Map([["appserver", "web"]]) };

  test("renames the managed depends_on key in place without rewriting its options", () => {
    const document = { services: { web: renderedOld.services.appserver, database } };

    const result = renameMigrationService(hunk, { ...context, document });

    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") throw new Error("Expected the rename to apply.");
    expect(getAtPath(result.document, "services.web.depends_on")).toEqual({ db: dependency, cache });
    expect(Object.keys(getAtPath(result.document, "services.web.depends_on") ?? {})).toEqual(["db", "cache"]);
  });

  test.each([
    ["replaced", { other: dependency, cache }],
    ["edited", { database: { ...dependency, required: true }, cache }],
    ["colliding", { database: dependency, db: cache, cache }],
  ])("blocks when a managed depends_on entry is %s", (_change, depends_on) => {
    const document = { services: { web: { depends_on }, database } };

    expect(renameMigrationService(hunk, { ...context, document })).toEqual({ kind: "blocking" });
  });

  test("recognizes the renamed depends_on key in an already migrated document", () => {
    const document = {
      recipe: { services: { database: "db" } },
      services: { web: { depends_on: { db: dependency, cache } }, db: database },
    };

    expect(renameAfterStateMatches(hunk, { ...context, document })).toBe(true);
  });
});

describe("pure recipe migration analysis", () => {
  test("commits both edges in order when the app is fully managed", () => {
    // Given
    const input = inputFor();
    const before = structuredClone({
      document: input.document,
      provenance: input.provenance,
      migrations: input.migrations,
    });
    // When
    const result = analyzeRecipeMigration(input);
    // Then
    expect(result.status).toBe("satisfied");
    expect(result.edges.map(statuses)).toEqual(["satisfied", "satisfied"]);
    expect(result.edges.map(classifications)).toEqual([
      ["selected", "selected", "selected"],
      ["selected", "selected", "selected"],
    ]);
    expect(result.edges.map((edge: AnalyzedEdge) => edge.hunks.map((hunk) => hunk.id))).toEqual(
      input.migrations.map((edge) => edge.hunks.map((hunk) => hunk.id)),
    );
    expect(requireEdge(result.edges[0]).from).toEqual(input.migrations[0].from);
    expect(requireEdge(result.edges[0]).to).toEqual(input.migrations[0].to);
    expect(requireEdge(result.edges[1]).from).toEqual(input.migrations[1].from);
    expect(requireEdge(result.edges[1]).to).toEqual(input.target.identity);
    expect(result.committed).toEqual(input.target.identity);
    expect(getAtPath(result.document, "recipe.producer")).toEqual(input.target.identity);
    expect(getAtPath(result.document, "recipe.version")).toBe("1.2.0");
    expect(getAtPath(result.document, "recipe.options.php")).toBe("8.3");
    expect(getAtPath(result.document, "services.appserver.environment")).toEqual({ FEATURE: "enabled" });
    expect(getAtPath(result.document, "services.appserver.port")).toBe(8080);
    expect(getAtPath(result.document, "services.appserver.webroot")).toBe("{{ recipe.webroot }}/public");
    expect({ document: input.document, provenance: input.provenance, migrations: input.migrations }).toEqual(
      before,
    );
  });

  test("commits only edge one when a structural conflict blocks edge two", () => {
    // Given
    const fixture = conflictingSecondEdgeFixture();
    // When
    const result = analyzeRecipeMigration({ ...fixture, decide: () => true });
    // Then
    expect(result.status).toBe("blocking");
    expect(result.edges.map(statuses)).toEqual(["satisfied", "blocking"]);
    expect(classifications(result.edges[1])).toContain("blocking");
    expect(result.committed).toEqual(fixture.migrations[0].to);
    expect(getAtPath(result.document, "recipe.version")).toBe("1.1.0");
    expect(getAtPath(result.document, "recipe.producer")).toEqual(fixture.migrations[0].to);
    expect(getAtPath(result.document, "services.appserver.port")).toBe(9000);
    expect(getAtPath(result.document, "services.appserver.environment")).toEqual({ FEATURE: "enabled" });
    expect(getAtPath(result.document, "services.db")).toBeUndefined();
    expect(getAtPath(result.document, "services.appserver.webroot")).toBe("{{ recipe.webroot }}");
  });

  test("blocks every later edge when the first edge is not owned by the canonical layer", () => {
    // Given
    const input = { ...inputFor(), migrations: makeMigrationFixture().nonCanonical };
    // When
    const result = analyzeRecipeMigration(input);
    // Then
    expect(result.edges.map(statuses)).toEqual(["blocking", "blocking"]);
    expect(classifications(result.edges[0])).toContain("blocking");
    expect(result.committed).toBeUndefined();
    expect(result.document).toEqual(input.document);
  });

  test("satisfies the edge with retained-option when the option is customized", () => {
    // Given
    const input = inputFor(customizedOptionLandofile());
    // When
    const result = analyzeRecipeMigration(input);
    // Then
    expect(classifications(result.edges[0])).toEqual(["retained-option", "selected", "selected"]);
    expect(result.edges.map(statuses)).toEqual(["satisfied", "satisfied"]);
    expect(result.committed).toEqual(input.target.identity);
    expect(getAtPath(result.document, "recipe.options.php")).toBe("8.4");
    expect(getAtPath(result.document, "services.appserver.type")).toBe("php:{{ recipe.php }}");
  });

  test("preserves a taken-over literal when its managed expression would change", () => {
    // Given
    const input = inputFor(takenOverLandofile());
    // When
    const result = analyzeRecipeMigration(input);
    // Then
    expect(getAtPath(result.document, "services.appserver.webroot")).toBe("/custom");
    expect(classifications(result.edges[1])).toContain("blocking");
    expect(result.committed).toEqual(input.migrations[0].to);
    expect(getAtPath(result.document, "services.appserver.port")).toBe(80);
    expect(getAtPath(result.document, "services.database")).toEqual(
      getAtPath(input.document, "services.database"),
    );
  });

  test("rewrites managed references and provenance atomically when a service is renamed", () => {
    // Given
    const input = inputFor();
    // When
    const result = analyzeRecipeMigration(input);
    // Then
    expect(getAtPath(result.document, "services.database")).toBeUndefined();
    expect(getAtPath(result.document, "services.db")).toEqual({ type: "{{ recipe.database }}" });
    expect(getAtPath(result.document, "recipe.services.database")).toBe("db");
    expect(getAtPath(result.document, "services.appserver.depends_on")).toEqual(["db"]);
    expect(getAtPath(result.document, "tooling.mysql.service")).toBe("db");
    expect(result.committed).toEqual(input.target.identity);
  });

  test("matches mapped paths when an existing appserver rename is recorded", () => {
    // Given
    const input = inputFor(renamedServiceLandofile());
    // When
    const result = analyzeRecipeMigration(input);
    // Then
    expect(result.committed).toEqual(input.target.identity);
    expect(getAtPath(result.document, "services.appserver")).toBeUndefined();
    expect(getAtPath(result.document, "services.web.port")).toBe(8080);
    expect(getAtPath(result.document, "services.web.depends_on")).toEqual(["db"]);
    expect(getAtPath(result.document, "recipe.services")).toEqual({ appserver: "web", database: "db" });
    expect(getAtPath(result.document, "tooling.php.service")).toBe("web");
  });

  test("rolls back the whole second edge when the rename target collides", () => {
    // Given
    const fixture = renameCollisionFixture();
    // When
    const result = analyzeRecipeMigration({ ...fixture, decide: () => true });
    // Then
    expect(result.edges.map(statuses)).toEqual(["satisfied", "blocking"]);
    expect(result.committed).toEqual(fixture.migrations[0].to);
    expect(getAtPath(result.document, "services.appserver.port")).toBe(80);
    expect(getAtPath(result.document, "services.db")).toEqual({ type: "redis:7" });
    expect(getAtPath(result.document, "services.database")).toEqual({ type: "{{ recipe.database }}" });
    expect(getAtPath(result.document, "recipe.services")).toBeUndefined();
    expect(getAtPath(result.document, "services.appserver.depends_on")).toEqual(["database"]);
    expect(getAtPath(result.document, "tooling.mysql.service")).toBe("database");
  });

  test("blocks without throwing when the second snapshot cannot render the current options", () => {
    // Given
    const input = { ...inputFor(), ...makeMigrationFixture().renderFailure };
    // When
    const result = analyzeRecipeMigration(input);
    // Then
    expect(result.edges.map(statuses)).toEqual(["satisfied", "blocking"]);
    expect(classifications(result.edges[1])).toContain("blocking");
    expect(result.committed).toEqual(input.migrations[0].to);
    expect(getAtPath(result.document, "services.appserver.port")).toBe(80);
  });

  test("does not commit a partially accepted edge when decide rejects selected hunks", () => {
    // Given
    const input = { ...inputFor(), decide: () => false };
    // When
    const result = analyzeRecipeMigration(input);
    // Then
    expect(result.edges.map(statuses)).toEqual(["blocking", "blocking"]);
    expect(result.committed).toBeUndefined();
    expect(result.document).toEqual(input.document);
  });

  test("satisfies pre-applied hunks without asking when their after-state already exists", () => {
    // Given
    const input = inputFor(
      managedLandofile().replace('php: "8.2"', 'php: "8.3"').replace('LEGACY: "yes"', 'FEATURE: "enabled"'),
    );
    const firstIds = new Set(input.migrations[0].hunks.map((hunk) => hunk.id));
    // When
    const result = analyzeRecipeMigration({
      ...input,
      decide: (hunk: { readonly id: string }) => {
        expect(firstIds.has(hunk.id)).toBe(false);
        return true;
      },
    });
    // Then
    expect(classifications(result.edges[0])).toEqual([
      "already-satisfied",
      "already-satisfied",
      "already-satisfied",
    ]);
    expect(result.committed).toEqual(input.target.identity);
  });

  test("blocks a pre-moved service whose managed references still use the old name", () => {
    // Given
    const input = inputFor(staleRenameRefsLandofile());
    // When
    const result = analyzeRecipeMigration(input);
    // Then
    expect(result.edges.map(statuses)).toEqual(["satisfied", "blocking"]);
    expect(result.committed).toEqual(input.migrations[0].to);
    expect(getAtPath(result.document, "recipe.version")).toBe("1.1.0");
    expect(getAtPath(result.document, "services.appserver.depends_on")).toEqual(["database"]);
    expect(getAtPath(result.document, "tooling.mysql.service")).toBe("database");
  });

  test("blocks a partial rename whose target exists with unrelated content", () => {
    // Given
    const input = inputFor(partialRenameLandofile());
    // When
    const result = analyzeRecipeMigration(input);
    // Then
    expect(result.edges.map(statuses)).toEqual(["satisfied", "blocking"]);
    expect(result.committed).toEqual(input.migrations[0].to);
    expect(getAtPath(result.document, "recipe.version")).toBe("1.1.0");
    expect(getAtPath(result.document, "services.db")).toEqual({ type: "redis:7" });
    expect(getAtPath(result.document, "services.appserver.depends_on")).toEqual(["database"]);
  });

  test("blocks when an option-default hunk disagrees with the new snapshot defaults", () => {
    // Given
    const base = inputFor();
    const [first, second] = base.migrations;
    if (first === undefined || second === undefined) throw new Error("Expected two migration edges.");
    const [phpDefault, ...rest] = first.hunks;
    if (phpDefault === undefined || phpDefault.kind !== "option-default") {
      throw new Error("Expected the first hunk to be an option-default.");
    }
    const input = {
      ...base,
      migrations: [{ ...first, hunks: [{ ...phpDefault, new: "9.9" }, ...rest] }, second],
    };
    // When
    const result = analyzeRecipeMigration(input);
    // Then
    expect(result.edges.map(statuses)).toEqual(["blocking", "blocking"]);
    expect(result.committed).toBeUndefined();
    expect(getAtPath(result.document, "recipe.options.php")).toBe("8.2");
  });

  test.each(["already-current", "missing-old-snapshot"] as const)(
    "preserves the document when path selection returns %s",
    (reason) => {
      // Given
      const base = inputFor();
      const producer =
        reason === "already-current"
          ? base.target.identity
          : { ...base.provenance.producer, contentDigest: `sha256:${"9".repeat(64)}` };
      const provenance = { ...base.provenance, producer, version: producer.manifestVersion };
      const input = { ...base, provenance, document: { ...base.document, recipe: provenance } };
      const selection = selectMigrationPath(input.migrations, producer, input.target.identity);
      // When
      const result = analyzeRecipeMigration(input);
      // Then
      expect(selection).toEqual({ kind: "no-mutation", reason });
      expect(result.status).toBe("no-mutation");
      expect(result.noMutation).toBe(reason);
      expect(result.edges).toEqual([]);
      expect(result.committed).toBeUndefined();
      expect(result.document).toEqual(input.document);
    },
  );
});
