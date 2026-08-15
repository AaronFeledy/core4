import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");
const contributingDocPaths = [
  "docs/contributing/ci.md",
  "docs/contributing/release.md",
  "docs/contributing/decisions.md",
] as const;
const legacyDocSlugs = ["ci-runbook", "release-runbook", "beta-1-decisions"] as const;
const legacyDocPaths = legacyDocSlugs.map((slug) => `docs/${slug}.md`);
const knownConsumerPaths = [
  "README.md",
  ".github/pull_request_template.md",
  "AGENTS.md",
  "scripts/build-release-workflow.ts",
  ".github/workflows/release.yml",
  "core/test/build/ci-runbook.test.ts",
  "core/test/build/branch-protection.test.ts",
  "core/test/build/paths-package-decision.test.ts",
  "core/test/scripts/codegen-ci.test.ts",
] as const;

describe("contributing docs", () => {
  test("publishes CI, release, and decision docs under docs/contributing", async () => {
    // Given: the public contributing-document layout.
    const docs = contributingDocPaths.map((path) => Bun.file(resolve(repoRoot, path)));

    // When: each expected document is checked.
    const exists = await Promise.all(docs.map((doc) => doc.exists()));

    // Then: all three documents are present.
    expect(exists).toEqual([true, true, true]);
  });

  test("starts each contributing document with title and description frontmatter", async () => {
    // Given: the public contributing documents.
    const docs = await Promise.all(
      contributingDocPaths.map((path) => Bun.file(resolve(repoRoot, path)).text()),
    );

    // When: their opening frontmatter is inspected.
    const frontmatter = docs.map((doc) =>
      doc.match(/^---\ntitle: [^\n]*\S[^\n]*\ndescription: [^\n]*\S[^\n]*\n---\n/),
    );

    // Then: every document declares a non-empty title and description.
    expect(frontmatter.every((match) => match !== null)).toBe(true);
  });

  test("uses a milestone-agnostic Decision log title", async () => {
    // Given: the public decision log.
    const decisions = await Bun.file(resolve(repoRoot, "docs/contributing/decisions.md")).text();

    // When: its metadata and first heading are inspected.
    const title = decisions.match(/^---\ntitle: ([^\n]+)\n/)?.[1];
    const heading = decisions.match(/^# (.+)$/m)?.[1];

    // Then: both surfaces use the milestone-agnostic title.
    expect(title).toBe("Decision log");
    expect(heading).toBe("Decision log");
  });

  test("removes the former top-level doc paths", async () => {
    // Given: the former internal-document paths.
    const docs = legacyDocPaths.map((path) => Bun.file(resolve(repoRoot, path)));

    // When: each former path is checked.
    const exists = await Promise.all(docs.map((doc) => doc.exists()));

    // Then: none of the former paths remain.
    expect(exists).toEqual([false, false, false]);
  });

  test("removes legacy doc references from known consumers", async () => {
    // Given: every known consumer outside docs/contributing.
    const consumers = await Promise.all(
      knownConsumerPaths.map(async (path) => ({
        path,
        text: await Bun.file(resolve(repoRoot, path)).text(),
      })),
    );
    const legacyReferences = legacyDocSlugs.map((slug) => `docs/${slug}.md`);

    // When: consumers are scanned for legacy references.
    const staleReferences = consumers.flatMap(({ path, text }) =>
      legacyReferences
        .filter((reference) => text.includes(reference))
        .map((reference) => `${path}: ${reference}`),
    );

    // Then: no known consumer points at a former path.
    expect(staleReferences).toEqual([]);
  });
});
