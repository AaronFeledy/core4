import { describe, expect, test } from "bun:test";
import { lintGuideContent, lintGuideTranscripts } from "../../../scripts/lint-guides.ts";
import { SOURCE, consumers, document, project, scenario } from "./fixtures/guide-conformance.ts";

describe("canonical guide placement", () => {
  test.each([
    ["Hidden", "Skip", "flow"],
    ["Skip", "Hidden", "flow"],
    ["Tab", "Hidden", "flow"],
    ["Tab", "Skip", "flow"],
    ["Hidden", "Tabs", "flow"],
    ["Skip", "Tabs", "flow"],
    ["Tab", "Tabs", "flow"],
    ["Hidden", "Tab", "flow"],
    ["Skip", "Tab", "flow"],
    ["Tab", "Tab", "flow"],
    ["Scenario", "Guide", "flow"],
    ["Step", "Scenario", "flow"],
    ["Scenario", "Run", "flow"],
    ["Guide", "Step", "flow"],
    ["Step", "Run", "inline"],
    ["root", "Guide", "inline"],
    ["root", "Run", "flow"],
  ])("rejects misplaced %s -> %s (%s) across consumers and lint", (parent, component, form) => {
    // Given
    const attributes: Readonly<Record<string, string>> = {
      Scenario: ' id="outer"',
      Step: ' name="outer"',
      Tab: ' name="outer"',
      Hidden: ' reason="Pending upstream support"',
      Skip: ' reason="Pending upstream support"',
      Run: ' command="lando version"',
    };
    const child = `<${component}${attributes[component] ?? ""} />`;
    const body = form === "inline" ? `Text ${child} after.` : child;
    const wrapped = `<${parent}${attributes[parent] ?? ""}>\n${body}\n</${parent}>`;
    const source =
      parent === "root"
        ? document("").replace("<Guide>\n\n</Guide>", body)
        : document(
            parent === "Guide"
              ? body
              : parent === "Scenario"
                ? wrapped
                : scenario(parent === "Tab" ? `<Tabs>\n${wrapped}\n</Tabs>` : wrapped),
          );
    const offset = source.indexOf(child);
    const before = source.slice(0, offset).split("\n");
    const expected = {
      code: form === "inline" ? "guide.structure.inline" : "guide.structure.placement",
      sourcePath: SOURCE,
      component,
      line: before.length,
      column: (before.at(-1)?.length ?? 0) + 1,
    };

    // When / Then
    for (const consumer of consumers) {
      let failure: unknown;
      try {
        consumer.run(source);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        ...expected,
        _tag: "GuideStructureError",
        remediation: expect.any(String),
      });
    }
    for (const lint of [lintGuideContent, lintGuideTranscripts])
      expect(lint(SOURCE, source).diagnostics).toMatchObject([
        { ...expected, remediation: expect.any(String) },
      ]);
  });

  test.each(["Just **prose**.\n\n```mdx\n<Run />\n```", "<Guide>\n\n## Prose only\n\n</Guide>"])(
    "preserves markdown-only and zero-scenario pages: %s",
    (body) => {
      // Given
      const source = document("").replace("<Guide>\n\n</Guide>", body);
      // When
      const result = project(source);
      // Then
      expect(result.guide.scenarios).toEqual([]);
      expect(result.lint).toEqual([]);
    },
  );
});
