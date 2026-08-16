import { describe, expect, test } from "bun:test";

import {
  type NormalizedContentMetadata,
  authoredText,
  deriveDescription,
  deriveTitle,
  normalizeContentMetadata,
} from "../src/lib/titles.ts";

// Compile-time contract: title is required and result stays a Record.
type _TitleIsRequired = NormalizedContentMetadata<{ id: string }> extends { readonly title: unknown }
  ? true
  : false;
type _ResultIsRecord = NormalizedContentMetadata<{ id: string }> extends Record<string, unknown>
  ? true
  : false;
type _OptionalTitleWouldPass = Partial<Pick<NormalizedContentMetadata<{ id: string }>, "title">> extends Pick<
  NormalizedContentMetadata<{ id: string }>,
  "title"
>
  ? true
  : false;
const _titleRequired = true satisfies _TitleIsRequired;
const _assignableToRecord = true satisfies _ResultIsRecord;
// If title were optional, Partial<Pick> would extend Pick — require false.
const _titleNotOptional = false satisfies _OptionalTitleWouldPass;
void _titleRequired;
void _assignableToRecord;
void _titleNotOptional;

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

describe("authoredText", () => {
  test("rejects blank and whitespace-only strings", () => {
    // Given / When / Then: empty and whitespace authored strings are absent.
    expect(authoredText("")).toBeUndefined();
    expect(authoredText("   ")).toBeUndefined();
    expect(authoredText(undefined)).toBeUndefined();
  });

  test("trims non-empty authored strings", () => {
    expect(authoredText(" Title ")).toBe("Title");
  });
});

describe("normalizeContentMetadata", () => {
  test("derives a title from a blank authored title string", () => {
    // Given: blank title frontmatter and a visible H1.
    const source = "# Visible title\n\nBody paragraph.";
    const data = { title: "   ", id: "blank-title" };

    // When: the loader normalizes metadata.
    const normalized = normalizeContentMetadata(data, source, "guides/blank-title");

    // Then: blank title is treated as absent and derived from the H1.
    expect(normalized.title).toBe("Visible title");
  });

  test("preserves non-string title values for schema rejection", () => {
    // Given: malformed numeric title that docsSchema must reject.
    const source = "# Heading\n\nBody.";
    const data = { title: 42, id: "bad-title" };

    // When: the loader normalizes metadata.
    const normalized = normalizeContentMetadata(data, source, "guides/bad-title");

    // Then: the invalid title remains unchanged so schema validation can fail.
    expect(normalized.title).toBe(42);
  });

  test("preserves non-string description values for schema rejection", () => {
    // Given: malformed numeric description.
    const source = "# Heading\n\nBody.";
    const data = { title: "Heading", description: 42 };

    // When: the loader normalizes metadata.
    const normalized = normalizeContentMetadata(data, source, "guides/bad-description");

    // Then: the invalid description remains rejectable.
    expect(normalized.description).toBe(42);
  });

  test("omits blank description when no derived description exists", () => {
    // Given: blank description and source with no prose paragraph.
    const source = "# Only a heading\n";
    const data = { title: "Only a heading", description: "   " };

    // When: the loader normalizes metadata.
    const normalized = normalizeContentMetadata(data, source, "guides/blank-description");

    // Then: blank description is omitted rather than retained.
    expect("description" in normalized).toBe(false);
    expect(normalized.title).toBe("Only a heading");
  });

  test("derives description when authored description is blank", () => {
    // Given: blank description and prose that can supply one.
    const source = "# Guide\n\nReadable first paragraph for SEO.\n";
    const data = { title: "Guide", description: "" };

    // When: the loader normalizes metadata.
    const normalized = normalizeContentMetadata(data, source, "guides/derive-description");

    // Then: blank description is replaced by derived prose.
    expect(normalized.description).toBe("Readable first paragraph for SEO.");
  });

  test("keeps a trimmed non-empty authored description", () => {
    // Given: authored description that should win over body prose.
    const source = "# Guide\n\nBody prose that must not win.\n";
    const data = { title: "Guide", description: "  Authored description  " };

    // When: the loader normalizes metadata.
    const normalized = normalizeContentMetadata(data, source, "guides/authored-description");

    // Then: authored description is trimmed and preserved.
    expect(normalized.description).toBe("Authored description");
  });
});
