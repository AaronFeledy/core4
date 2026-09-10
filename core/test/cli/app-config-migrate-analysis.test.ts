import { describe, expect, test } from "bun:test";
import { getAtPath } from "@lando/engine/config-write/dot-path";
import { selectMigrationPath } from "@lando/sdk/recipes";
import type { RecipeHunkClassification, RecipeProducer } from "@lando/sdk/schema";
import { analyzeRecipeMigration } from "../../src/cli/commands/app-config-migrate-analysis.ts";
import {
  conflictingSecondEdgeFixture,
  customizedOptionLandofile,
  makeMigrationFixture,
  managedLandofile,
  parseMigrationLandofile,
  renameCollisionFixture,
  renamedServiceLandofile,
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
    expect(getAtPath(result.document, "services.appserver.dependsOn")).toEqual(["db"]);
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
    expect(getAtPath(result.document, "services.web.dependsOn")).toEqual(["db"]);
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
    expect(getAtPath(result.document, "services.appserver.dependsOn")).toEqual(["database"]);
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
