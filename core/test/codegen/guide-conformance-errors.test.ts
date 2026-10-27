import { describe, expect, test } from "bun:test";
import { GuideSemanticError } from "../../../scripts/guides/diagnostic.ts";
import { lintGuideContent, lintGuideTranscripts } from "../../../scripts/lint-guides.ts";
import { SOURCE, consumers, document, project, scenario, step } from "./fixtures/guide-conformance.ts";

const invalidCases = [
  {
    name: "missing reference",
    body: step('<Run command="lando info {{missing}}" />'),
    code: "guide.variable.missing",
  },
  {
    name: "missing spaced reference",
    body: step('<Run command="lando info {{ missing }}" />'),
    code: "guide.variable.missing",
  },
  {
    name: "unused binding",
    body: step('<Variable name="unused" value="private-value" /><Run command="lando version" />'),
    code: "guide.variable.unused",
  },
  {
    name: "opaque use does not consume a binding",
    body: step('<Variable name="unused" value="private-value" /><Run shell="printf {{unused}}" />'),
    code: "guide.variable.unused",
  },
  {
    name: "invalid name",
    body: step('<Variable name="foreign.path" value="private-value" /><Run command="lando version" />'),
    code: "guide.variable.invalid-name",
  },
  {
    name: "identical redefinition",
    body: step(
      '<Variable name="same" value="private-value" /><Variable name="same" value="private-value" /><Run command="lando info {{same}}" />',
    ),
    code: "guide.variable.duplicate",
  },
  {
    name: "hidden redefinition",
    body: `${step('<Variable name="same" value="private-value" /><Run command="lando info {{same}}" />')}<Hidden reason="Internal deterministic setup">${step('<Variable name="same" value="private-value" />', "hidden")}</Hidden>`,
    code: "guide.variable.duplicate",
  },
  {
    name: "hidden reference with a display",
    body: `<Hidden reason="Internal deterministic setup">${step('<Variable name="secret" value="private-value" display="shown" />', "hidden")}</Hidden>${step('<Run command="lando info {{secret}}" />')}`,
    code: "guide.variable.hidden-reference",
  },
  {
    name: "mixed cleanup mode",
    body: `${step('<Run command="lando version" />')}<Hidden reason="Internal cleanup coverage">${step('<Cleanup /><Run runtime="library" code="private-value" displayCode="shown" />', "cleanup")}</Hidden>`,
    code: "guide.runtime.mixed",
  },
] as const;

const multipleGuideSource = `${document(scenario(step('<Run command="lando version" />'), "first"))}
<Guide>
${scenario(step('<Run command="lando info" />'), "second")}
</Guide>
`;

describe("canonical guide rejection", () => {
  test.each([...consumers])("rejects multiple top-level Guide roots in $name", (consumer) => {
    let failure: unknown;

    try {
      consumer.run(multipleGuideSource);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      _tag: "GuideRootError",
      code: "guide.multiple-guides",
      sourcePath: SOURCE,
      component: "Guide",
      line: 14,
      relatedDeclarationLine: 6,
    });
    if (!(failure instanceof Error)) throw failure;
    expect(failure.message).toContain(`${SOURCE}:6`);
    expect(failure.message).toContain(`${SOURCE}:14`);
  });

  test.each([lintGuideContent, lintGuideTranscripts])(
    "source-locates multiple Guide roots in lint %#",
    (lint) => {
      const result = lint(SOURCE, multipleGuideSource);

      expect(result.diagnostics).toMatchObject([
        {
          code: "guide.multiple-guides",
          sourcePath: SOURCE,
          line: 14,
          relatedDeclarationLine: 6,
          component: "Guide",
          remediation: expect.any(String),
        },
      ]);
    },
  );

  for (const item of invalidCases)
    test(item.name, () => {
      // Given
      const source = document(scenario(item.body));
      // When / Then
      for (const consumer of consumers) {
        try {
          consumer.run(source);
          expect.unreachable(`${consumer.name} accepted ${item.name}`);
        } catch (error) {
          if (!(error instanceof GuideSemanticError)) throw error;
          expect(error).toMatchObject({
            code: item.code,
            sourcePath: SOURCE,
            scenario: "reader",
            variant: "",
          });
          expect(error.line).toBeGreaterThan(0);
          expect(error.component.length).toBeGreaterThan(0);
          expect(error.prop.length).toBeGreaterThan(0);
          expect(error.remediation.length).toBeGreaterThan(0);
          expect(JSON.stringify(error)).not.toContain("private-value");
        }
      }
      expect(lintGuideContent(SOURCE, source).diagnostics).toMatchObject([
        { code: item.code, sourcePath: SOURCE, scenario: "reader", variant: "" },
      ]);
      expect(lintGuideTranscripts(SOURCE, source).diagnostics).toMatchObject([{ code: item.code }]);
    });

  test("rejects orthogonal selected-tab redefinitions with both declaration locations", () => {
    const tab = (axis: string) =>
      `<Tabs axis="${axis}"><Tab name="one">${step('<Variable name="shared" value="private-value" /><Run command="lando info {{shared}}" />', axis)}</Tab></Tabs>`;
    const source = document(
      scenario(`${tab("left")}\n${tab("right")}`),
      "axes:\n  left: [one]\n  right: [one]\n",
    );

    const diagnostics = lintGuideContent(SOURCE, source).diagnostics;

    expect(diagnostics).toMatchObject([
      { code: "guide.variable.duplicate", variant: "left=one right=one", name: "shared" },
    ]);
    expect(diagnostics[0]?.line).toBeGreaterThan(diagnostics[0]?.relatedDeclarationLine ?? 0);
    expect(JSON.stringify(diagnostics)).not.toContain("private-value");
    for (const consumer of consumers) expect(() => consumer.run(source)).toThrow(GuideSemanticError);
  });

  test.each([
    '<Run runtime="library" code="yield* Effect.void;" />',
    '<Run runtime="library" code="yield* Effect.void;" displayCode="shown" command="lando version" />',
    "<Bogus />",
  ])("rejects invalid component props consistently: %s", (component) => {
    const source = document(scenario(step(component)));

    for (const consumer of consumers) expect(() => consumer.run(source)).toThrow();

    expect(lintGuideContent(SOURCE, source).diagnostics.length).toBeGreaterThan(0);
  });

  test("rejects e2e library mode even in a skipped cell", () => {
    const source = document(
      scenario(step('<Cleanup /><Run runtime="library" code="yield* Effect.void;" displayCode="shown" />')),
      "defaultLayer: e2e\nskip:\n  reason: Pending provider support\n",
    );

    for (const consumer of consumers) expect(() => consumer.run(source)).toThrow(GuideSemanticError);

    expect(lintGuideContent(SOURCE, source).diagnostics).toMatchObject([
      { code: "guide.runtime.e2e-library" },
    ]);
  });

  test("decodes Skip bodies without activating their bindings or references", () => {
    const source = document(
      scenario(
        `<Skip reason="Pending upstream support">${step('<Variable name="unused" value="private-value" /><Run command="lando info {{missing}}" />', "parked")}</Skip>${step('<Run command="lando version" />')}`,
      ),
    );

    const result = project(source);

    expect(result.lint).toEqual([]);
    expect(result.cells[0]?.test).toContain('test.skip("parked"');
    expect(result.cells[0]?.test).not.toContain("private-value");
    expect(result.readmes[0]?.markdown).not.toContain("{{missing}}");
    for (const consumer of consumers)
      expect(() =>
        consumer.run(
          source.replace(
            '<Run command="lando info {{missing}}" />',
            '<Run runtime="library" code="invalid" />',
          ),
        ),
      ).toThrow();
  });

  test.each(["", "tabs: [first, second]\n"])(
    "inherits whole-guide skip without omitting scaffold cells: %s",
    (axes) => {
      const source = document(
        scenario(step('<Run command="lando version" />')),
        `${axes}skip:\n  reason: Pending upstream support\n`,
      );

      const result = project(source);

      expect(result.lint).toEqual([]);
      expect(result.cells.length).toBe(axes === "" ? 1 : 2);
      expect(
        result.cells.every((cell) => cell.test.includes("test.skip(") && cell.transcript === undefined),
      ).toBe(true);
      expect(result.readmes).toHaveLength(result.cells.length);
      expect(result.readmes.every((readme) => readme.markdown.includes("lando version"))).toBe(true);
      const invalid = source.replace("lando version", "lando info {{missing}}");
      for (const consumer of consumers) expect(() => consumer.run(invalid)).toThrow(GuideSemanticError);
    },
  );
});
