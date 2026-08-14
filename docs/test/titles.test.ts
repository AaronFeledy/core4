import { describe, expect, test } from "bun:test";

import { deriveDescription, deriveTitle } from "../src/lib/titles.ts";

describe("derived content titles", () => {
  test("uses the first visible H1 when frontmatter has no title", () => {
    // Given: MDX with two visible top-level headings.
    const source = "# **First** [heading](/first)\n\nIntro.\n\n# Second heading";

    // When: the loader derives a title.
    const title = deriveTitle(source, {}, "guides/fallback");

    // Then: the first heading supplies the plain-text title.
    expect(title).toBe("First heading");
  });

  test("ignores H1 headings inside Hidden blocks", () => {
    // Given: an internal heading before the first reader-visible heading.
    const source = "<Hidden>\n# Internal setup\n</Hidden>\n\n# Public workflow";

    // When: the loader derives a title.
    const title = deriveTitle(source, {}, "guides/fallback");

    // Then: hidden authoring content cannot name the page.
    expect(title).toBe("Public workflow");
  });

  test("preserves an authored frontmatter title", () => {
    // Given: parsed frontmatter with a title that differs from the body heading.
    const source = "# Body heading";
    const frontmatter = { title: "Authored title" };

    // When: the loader derives a title.
    const title = deriveTitle(source, frontmatter, "guides/fallback");

    // Then: authored metadata wins.
    expect(title).toBe("Authored title");
  });

  test("humanizes the guide id when no H1 exists", () => {
    // Given: guide metadata without an authored title or body heading.
    const source = "A guide introduction without a heading.";
    const frontmatter = { id: "php-version-matrix" };

    // When: the loader derives a title.
    const title = deriveTitle(source, frontmatter, "guides/fallback");

    // Then: the stable guide id supplies a readable title.
    expect(title).toBe("PHP version matrix");
  });

  test("humanizes the final slug segment when metadata has no id", () => {
    // Given: content with only its loader-generated slug as a fallback.
    const source = "Content without a heading.";

    // When: the loader derives a title.
    const title = deriveTitle(source, {}, "guides/node-postgres");

    // Then: the final slug segment supplies a readable title.
    expect(title).toBe("Node postgres");
  });
});

describe("derived content descriptions", () => {
  test("uses the first prose paragraph without Markdown or JSX", () => {
    // Given: MDX whose first prose paragraph contains inline markup.
    const source = [
      "# Configure apps",
      "",
      "Build **Lando** apps with [portable config](/config), `fast` workflows, and <span>clear</span> docs.",
      "",
      "This second paragraph must not be selected.",
    ].join("\n");

    // When: the loader derives a description.
    const description = deriveDescription(source);

    // Then: only plain text from the first prose paragraph remains.
    expect(description).toBe("Build Lando apps with portable config, fast workflows, and clear docs.");
  });

  test("truncates long prose descriptions to 160 characters", () => {
    // Given: a first prose paragraph longer than Starlight's recommended limit.
    const source = `# Long guide\n\n${"portable workflows ".repeat(20)}`;

    // When: the loader derives a description.
    const description = deriveDescription(source);

    // Then: the description is bounded and visibly truncated.
    expect(description?.length).toBeLessThanOrEqual(160);
    expect(description?.endsWith("…")).toBe(true);
  });
});
