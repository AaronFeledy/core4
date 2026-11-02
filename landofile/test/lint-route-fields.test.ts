import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { attributeEffectiveLintIssue, lintLandofileSnapshot } from "../src/lint.ts";

test("route fields are retained for the planner and effective issues receive source coordinates", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-lint-route-fields-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      "name: routes\nservices:\n  web:\n    routes:\n      - hostname: app.site:80\n",
    );
    const snapshot = await Effect.runPromise(lintLandofileSnapshot({ cwd: root }));
    expect(snapshot.result.violations).toEqual([]);
    expect(snapshot.landofilePath).toBe(join(root, ".lando.yml"));
    if (snapshot.resolved === undefined) throw new Error("Expected retained Landofile");
    const issue = attributeEffectiveLintIssue(snapshot.resolved, {
      rule: "landofile.route",
      path: ["services", "web", "routes", 0, "hostname"],
      message: "Invalid hostname",
      suggestion: "Use a hostname only.",
    });
    expect(issue).toMatchObject({
      rule: "landofile.route",
      severity: "error",
      scopes: ["effective"],
      line: 5,
      source: {
        file: join(root, ".lando.yml"),
        layer: "canonical",
        path: ["services", "web", "routes", 0, "hostname"],
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an effective issue keeps the source its producer attributed", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-lint-issue-source-"));
  try {
    await writeFile(join(root, ".lando.yml"), "name: source\nservices:\n  web:\n    type: nginx\n");
    const snapshot = await Effect.runPromise(lintLandofileSnapshot({ cwd: root }));
    if (snapshot.resolved === undefined) throw new Error("Expected retained Landofile");
    const source = {
      file: join(root, ".lando.yml"),
      layer: "canonical" as const,
      path: ["services", "web", "type"],
    };
    // When
    const issue = attributeEffectiveLintIssue(snapshot.resolved, {
      rule: "landofile.tooling",
      path: ["tooling", "run"],
      message: "Reserved",
      source,
    });
    // Then
    expect(issue).toMatchObject({ source, line: 4, column: 5 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
