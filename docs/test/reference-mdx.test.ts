import { describe, expect, test } from "bun:test";

import { escapeReferenceMdxPlaceholders } from "../src/reference-mdx.ts";

describe("escapeReferenceMdxPlaceholders", () => {
  test("leaves placeholders inside backtick fences untouched", () => {
    // Given: a fenced code block with a lowercase placeholder tag.
    const source = ["before <foo>", "```", "const x = <foo>;", "```", "after <foo>"].join("\n");

    // When: placeholders are escaped for MDX.
    const result = escapeReferenceMdxPlaceholders(source);

    // Then: only outside-fence placeholders become entities.
    expect(result).toBe(
      ["before &lt;foo&gt;", "```", "const x = <foo>;", "```", "after &lt;foo&gt;"].join("\n"),
    );
  });

  test("leaves placeholders inside tilde fences untouched", () => {
    // Given: a ~~~ fenced block containing a placeholder.
    const source = ["intro <bar>", "~~~", "keep <bar>", "~~~", "outro <bar>"].join("\n");

    // When: placeholders are escaped for MDX.
    const result = escapeReferenceMdxPlaceholders(source);

    // Then: tilde fences protect their contents the same way.
    expect(result).toBe(["intro &lt;bar&gt;", "~~~", "keep <bar>", "~~~", "outro &lt;bar&gt;"].join("\n"));
  });

  test("a tilde fence line inside an open backtick fence does not toggle fencing", () => {
    // Given: a ``` block that contains a bare ~~~ line.
    const source = ["```", "~~~", "still fenced <foo>", "```", "outside <foo>"].join("\n");

    // When: placeholders are escaped for MDX.
    const result = escapeReferenceMdxPlaceholders(source);

    // Then: the inner ~~~ is not a closer; only the matching ``` ends the fence.
    expect(result).toBe(["```", "~~~", "still fenced <foo>", "```", "outside &lt;foo&gt;"].join("\n"));
  });

  test("an unterminated fence swallows the rest of the file", () => {
    // Given: an opening fence with no closer and placeholders after it.
    const source = ["start <foo>", "```", "inside <foo>", "still inside <bar>"].join("\n");

    // When: placeholders are escaped for MDX.
    const result = escapeReferenceMdxPlaceholders(source);

    // Then: nothing after the open fence is escaped.
    expect(result).toBe(["start &lt;foo&gt;", "```", "inside <foo>", "still inside <bar>"].join("\n"));
  });

  test("preserves placeholders inside inline code spans", () => {
    // Given: a line with both an inline code span and a free placeholder.
    const source = "see `<foo>` and also <foo> bare";

    // When: placeholders are escaped for MDX.
    const result = escapeReferenceMdxPlaceholders(source);

    // Then: the span keeps raw angle brackets; the bare tag is escaped.
    expect(result).toBe("see `<foo>` and also &lt;foo&gt; bare");
  });

  test("escapes bare lowercase placeholders outside code", () => {
    // Given: a plain prose line with a simple placeholder.
    const source = "use <foo> here";

    // When: placeholders are escaped for MDX.
    const result = escapeReferenceMdxPlaceholders(source);

    // Then: angle brackets become HTML entities.
    expect(result).toBe("use &lt;foo&gt; here");
  });

  test("escapes hyphen, underscore, and space separators in placeholders", () => {
    // Given: placeholders with each allowed internal separator.
    const source = "<foo-bar> <foo_bar> <foo bar>";

    // When: placeholders are escaped for MDX.
    const result = escapeReferenceMdxPlaceholders(source);

    // Then: all three forms match the placeholder pattern and escape.
    expect(result).toBe("&lt;foo-bar&gt; &lt;foo_bar&gt; &lt;foo bar&gt;");
  });

  test("leaves uppercase-first and digit-first tags untouched", () => {
    // Given: tags that fail the lowercase-leading placeholder pattern.
    const source = "component <Foo> and numeric <1foo>";

    // When: placeholders are escaped for MDX.
    const result = escapeReferenceMdxPlaceholders(source);

    // Then: neither form is treated as a placeholder.
    expect(result).toBe("component <Foo> and numeric <1foo>");
  });
});
