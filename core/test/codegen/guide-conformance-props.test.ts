import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintGuideContent, lintGuideTranscripts, lintGuides } from "../../../scripts/lint-guides.ts";
import { SOURCE, consumers, document, scenario, step } from "./fixtures/guide-conformance.ts";

const cases = [
  { component: "Run", prop: "command", markup: "<Run command={1 + 2} />" },
  { component: "UseFixture", prop: "name", markup: "<UseFixture name={{privatePayload: secret}} />" },
  { component: "Run", prop: "command", markup: "<Run command={`privatePayload${secret}`} />" },
  { component: "Run", prop: "command", markup: '<Run command={"privatePayload" + "suffix"} />' },
  { component: "Run", prop: "attributes", markup: '<Run {...privatePayload} command="lando version" />' },
  { component: "Guide", prop: "scaffoldStrip", markup: "<Guide scaffoldStrip={privatePayload}>" },
  { component: "Guide", prop: "scaffoldStrip", markup: '<Guide scaffoldStrip="privatePayload">' },
  { component: "UseFixture", prop: "name", markup: "<UseFixture name={42} />" },
  { component: "Run", prop: "displayCode", markup: '<Run runtime="library" code="privatePayload" />' },
  {
    component: "Verify",
    prop: "expect.regex",
    markup: '<Verify command="lando version" expect={{ regex: { value: "privatePayload" } }} />',
  },
] as const;

describe("source-located guide prop boundary", () => {
  for (const item of cases) {
    const source =
      item.component === "Guide"
        ? document(scenario(step('<Run command="lando version" />'))).replace("<Guide>", item.markup)
        : document(scenario(step(item.markup)));
    const line = source.split("\n").findIndex((text) => text.includes(item.markup)) + 1;

    test.each([...consumers])(
      `rejects malformed ${item.component}.${item.prop} in $name: ${item.markup}`,
      (consumer) => {
        // Given / When
        let failure: unknown;
        try {
          consumer.run(source);
        } catch (error) {
          failure = error;
        }
        // Then
        expect(failure).toMatchObject({
          _tag: "GuidePropError",
          sourcePath: SOURCE,
          line,
          component: item.component,
          prop: item.prop,
          remediation: expect.stringContaining("bun run lint:guides"),
        });
        expect(JSON.stringify(failure)).not.toContain("privatePayload");
      },
    );

    test.each([lintGuideContent, lintGuideTranscripts])(
      `returns malformed ${item.component}.${item.prop} diagnostics in lint %#: ${item.markup}`,
      (lint) => {
        // Given / When
        const result = lint(SOURCE, source);
        // Then
        expect(result.diagnostics).toMatchObject([
          {
            sourcePath: SOURCE,
            line,
            component: item.component,
            prop: item.prop,
            remediation: expect.stringContaining("bun run lint:guides"),
          },
        ]);
        expect(JSON.stringify(result)).not.toContain("privatePayload");
      },
    );
  }

  test("continues linting other files after malformed props and MDX syntax", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-prop-boundary-"));
    try {
      await Bun.write(join(root, "guides/a.mdx"), document(scenario(step("<Run command={1 + 2} />"))));
      await Bun.write(join(root, "guides/b.mdx"), document(scenario(step("<UseFixture name={42} />"))));
      await Bun.write(join(root, "guides/c.mdx"), document(scenario(step("<Run command={ />"))));
      await Bun.write(
        join(root, "guides/d.mdx"),
        document(scenario(step('<Run command="lando version" />'))),
      );
      // When
      const result = await lintGuides(root, { guideRoot: "guides" });
      // Then
      expect(result.diagnostics.map((entry) => entry.sourcePath)).toEqual([
        "guides/a.mdx",
        "guides/b.mdx",
        "guides/c.mdx",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
