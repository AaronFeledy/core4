import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");

const readText = async (path: string): Promise<string> => Bun.file(path).text();

const FRONTMATTER_PATTERN = /^---\ntitle: (.+)\ndescription: (.+)\n---\n/;

const STAY_PUT_DOCS = [
  "docs/alpha-install-and-bug-reports.md",
  "docs/embedding.md",
  "docs/php-base-images.md",
  "docs/telemetry/events.md",
  "docs/telemetry/retention.md",
];

describe("stay-put docs Starlight frontmatter", () => {
  for (const relativePath of STAY_PUT_DOCS) {
    test(`${relativePath} starts with frontmatter matching its h1`, async () => {
      // Given a stay-put doc page
      const docPath = resolve(repoRoot, relativePath);
      const contents = await readText(docPath);

      // When reading its leading frontmatter block and first heading
      const frontmatterMatch = contents.match(FRONTMATTER_PATTERN);
      const bodyAfterFrontmatter = contents.slice(frontmatterMatch?.[0].length ?? 0);
      const headingMatch = bodyAfterFrontmatter.match(/^# (.+)\n/m);

      // Then the frontmatter has a non-empty title equal to the h1 text, and a non-empty description
      expect(frontmatterMatch).not.toBeNull();
      const title = frontmatterMatch?.[1] ?? "";
      const description = frontmatterMatch?.[2] ?? "";
      expect(title.length).toBeGreaterThan(0);
      expect(description.length).toBeGreaterThan(0);
      expect(headingMatch).not.toBeNull();
      expect(title).toBe(headingMatch?.[1] ?? "");
    });
  }
});
