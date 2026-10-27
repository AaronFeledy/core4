import { describe, expect, test } from "bun:test";
import { GuideSemanticError } from "../../../scripts/guides/diagnostic.ts";
import { lintGuideContent, lintGuideTranscripts } from "../../../scripts/lint-guides.ts";
import { SOURCE, consumers, document, project, scenario, step } from "./fixtures/guide-conformance.ts";

const library = step(
  '<Run runtime="library" code="yield* Effect.void;" displayCode="await inspectApp(app);" />',
  "library",
);
const verification = step('<Verify command="version" />', "cli");

describe("selected scenario runtime mode", () => {
  for (const hidden of [false, true])
    for (const reversed of [false, true])
      test.each(["", "skip:\n  reason: Pending upstream support\n"])(
        `rejects command verification with library execution (hidden=${hidden}, reversed=${reversed}, skip=%s)`,
        (frontmatter) => {
          // Given
          const command = hidden
            ? `<Hidden reason="Private assertion coverage">${verification}</Hidden>`
            : verification;
          const body = reversed ? `${command}\n${library}` : `${library}\n${command}`;
          const source = document(scenario(body), frontmatter);

          // When / Then
          for (const consumer of consumers) expect(() => consumer.run(source)).toThrow(GuideSemanticError);
          for (const lint of [lintGuideContent, lintGuideTranscripts])
            expect(lint(SOURCE, source).diagnostics).toMatchObject([{ code: "guide.runtime.mixed" }]);
        },
      );

  test("leaves command verification inside Skip inactive", () => {
    // Given
    const source = document(
      scenario(`${library}\n<Skip reason="Pending upstream support">${verification}</Skip>`),
    );
    // When
    const result = project(source);
    // Then
    expect(result.guide.cells[0]?.resolved.runMode).toBe("library");
    expect(result.lint).toEqual([]);
    expect(result.cells[0]?.test).toContain('test.skip("cli"');
    expect(result.cells[0]?.test).not.toContain('context.runCli("version"');
  });

  test("keeps non-command verification compatible with library mode", () => {
    // Given
    const source = document(scenario(`${library}\n${step('<Verify event="post-start" />', "assert")}`));
    // When
    const result = project(source);
    // Then
    expect(result.guide.cells[0]?.resolved.runMode).toBe("library");
    expect(result.lint).toEqual([]);
  });
});
