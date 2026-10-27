import { describe, expect, test } from "bun:test";
import { document, project, scenario, step } from "./fixtures/guide-conformance.ts";

describe("canonical guide projections", () => {
  test.each(["", " ", "\t", "\n"])(
    "projects every whitelisted prop with identifier padding %j",
    (padding) => {
      // Given
      const source = document(
        scenario(
          step(`<Variable name="target" value="internal" display="shown" />
<Run command="lando info {{target}}" answers={{ choice: "{{opaque}} {{ opaque }}" }} />
<Verify command="lando status {{target}}" expect={{ regex: "{{opaque}}" }} />
<Verify file="{{target}}.txt" />
<Inspect file="{{target}}.json" />
<Inspect json="{{target}}.field" />`),
        ),
      ).replaceAll("{{target}}", `{{${padding}target${padding}}}`);
      // When
      const result = project(source);
      // Then
      expect(result.lint).toEqual([]);
      expect(result.cells[0]?.test).toContain('context.runCli("lando info internal"');
      expect(result.cells[0]?.test).toContain('context.runCli("lando status internal")');
      expect(result.cells[0]?.test).toContain('join(context.testDir, "internal.txt")');
      expect(result.cells[0]?.test).toContain('context.inspect({ file: "internal.json" })');
      expect(result.cells[0]?.test).toContain('context.inspect({ json: "internal.field" })');
      expect(result.cells[0]?.transcript?.frames.filter((frame) => frame.kind !== "step")).toMatchObject([
        { commandDisplay: "lando info shown" },
        { commandDisplay: "lando status shown", resultSummary: 'command "lando status shown" succeeds' },
        { resultSummary: 'file "shown.txt" matches expectation' },
        { displayText: 'inspect file "shown.json"' },
        { displayText: 'inspect json "shown.field"' },
      ]);
      expect(result.readmes[0]?.markdown).toContain("lando info shown");
      expect(result.cells[0]?.test).toContain('"choice":"{{opaque}} {{ opaque }}"');
      expect(result.cells[0]?.test).toContain('"regex": "{{opaque}}"');
    },
  );

  test.each([true, false])(
    "keeps authored CLI/library/CLI cleanup order without cross-scenario bindings: %s",
    (reverse) => {
      const cli = scenario(
        step('<Variable name="app" value="private" display="reader" /><Run command="lando start {{app}}" />'),
        "z-first",
      );
      const library = scenario(
        step(
          '<Cleanup /><Run runtime="library" code="yield* Effect.void;" displayCode="await destroy(app);" />',
        ),
        "a-library",
      );
      const cleanup = scenario(
        step(
          '<Variable name="app" value="other-private" display="other-reader" /><Cleanup /><Run command="lando destroy {{app}}" />',
        ),
        "m-last",
      );
      const source = document((reverse ? [cleanup, library, cli] : [cli, library, cleanup]).join("\n"));

      const result = project(source);

      expect(result.lint).toEqual([]);
      expect(result.guide.scenarios.map((node) => node.id)).toEqual(
        reverse ? ["m-last", "a-library", "z-first"] : ["z-first", "a-library", "m-last"],
      );
      expect(result.readmes[0]?.markdown.match(/```[^\n]*\n[\s\S]*?```/g)).toEqual([
        "```bash\nlando start reader\n```",
        ...(reverse
          ? ["```bash\nlando destroy other-reader\n```", "```ts\nawait destroy(app);\n```"]
          : ["```ts\nawait destroy(app);\n```", "```bash\nlando destroy other-reader\n```"]),
      ]);
    },
  );

  test("precollects selected tab bindings while preserving that tab's step order", () => {
    const source = document(
      scenario(`<Tabs>
<Tab name="first">${step('<Run command="lando info {{app}}" />', "a")}${step('<Variable name="app" value="first-value" /><Run command="lando version" />', "b")}</Tab>
<Tab name="second">${step('<Variable name="app" value="second-value" /><Run command="lando version" />', "b")}${step('<Run command="lando info {{app}}" />', "a")}${step('<Run command="lando status" />', "c")}</Tab>
</Tabs>`),
      "tabs: [first, second]\n",
    );

    const result = project(source);

    expect(result.lint).toEqual([]);
    expect(
      result.cells.map((cell) =>
        cell.transcript?.frames.filter((frame) => frame.kind === "step").map((frame) => frame.displayText),
      ),
    ).toEqual([
      ["a", "b"],
      ["b", "a", "c"],
    ]);
    expect(result.cells[0]?.test).toContain('context.runCli("lando info first-value"');
    expect(result.cells[0]?.test).toContain('test.skip("c"');
    expect(result.cells[1]?.test.indexOf("// @step: b")).toBeLessThan(
      result.cells[1]?.test.indexOf("// @step: a") ?? 0,
    );
    expect(result.readmes[1]?.markdown.indexOf("## 1. b")).toBeLessThan(
      result.readmes[1]?.markdown.indexOf("## 2. a") ?? 0,
    );
  });

  test("keeps shell, library, Inline, matcher and foreign template syntax opaque", () => {
    const source = document(
      [
        scenario(
          step(
            '<Run shell="printf {{shell}} {{ shell }} {{ foreign.value }}" /><Inline lang="ts" code="const x = &quot;{{inline}}&quot;;" justification="Literal template demonstration" />',
          ),
          "cli",
        ),
        scenario(
          step(
            '<Run runtime="library" code="const x = &quot;{{code}} {{ code }}&quot;;" displayCode="const x = &quot;{{display}} {{ display }}&quot;;" />',
          ),
          "library",
        ),
        scenario(
          step(
            '<Run command="lando info {{foreign.value}} {{ foreign.path }}" /><Verify command="lando version" expect={{ regex: "{{matcher}} {{ matcher }}" }} />',
          ),
          "foreign",
        ),
      ].join("\n"),
    );

    const result = project(source);

    expect(result.lint).toEqual([]);
    expect(result.cells[0]?.test).toContain(
      'context.shell("printf {{shell}} {{ shell }} {{ foreign.value }}")',
    );
    expect(result.cells[1]?.test).toContain('const x = "{{code}} {{ code }}";');
    expect(result.cells[1]?.transcript?.frames[1]?.commandDisplay).toBe(
      'const x = "{{display}} {{ display }}";',
    );
    expect(result.readmes[0]?.markdown).toContain("printf {{shell}} {{ shell }} {{ foreign.value }}");
    expect(result.cells[2]?.test).toContain("{{foreign.value}} {{ foreign.path }}");
    expect(result.cells[2]?.test).toContain('"regex": "{{matcher}} {{ matcher }}"');
  });

  test("accepts explicit empty values and treats substituted values as single-pass literals", () => {
    const source = document(
      scenario(
        step(
          '<Variable name="empty" value="" display="" /><Variable name="literal" value="{{other}}" display="{{display}}" /><Run command="lando info {{empty}} {{literal}}" />',
        ),
      ),
    );

    const result = project(source);

    expect(result.lint).toEqual([]);
    expect(result.cells[0]?.test).toContain('context.runCli("lando info  {{other}}"');
    expect(result.cells[0]?.transcript?.frames[1]?.commandDisplay).toBe("lando info  {{display}}");
    expect(result.readmes[0]?.markdown).toContain("lando info  {{display}}");
  });

  test("allows hidden execution to use public and hidden bindings while test-only scenarios have no public steps", () => {
    const source =
      document(`<Scenario id="visible">${step('<Variable name="public" value="visible-value" /><Run command="lando info {{public}}" />')}
<Hidden reason="Prepare isolated internal state">${step('<Variable name="secret" value="private-value" display="masked" /><Run command="lando info {{public}} {{secret}}" />', "internal")}</Hidden></Scenario>
<Scenario id="test-only" render={false} reason="Internal regression coverage">${step('<Variable name="public" value="test-value" /><Run command="lando info {{public}}" />')}</Scenario>`);

    const result = project(source);

    expect(result.lint).toEqual([]);
    expect(result.cells[0]?.test).toContain('context.runCli("lando info visible-value private-value"');
    expect(result.cells[1]?.transcript).toBeUndefined();
    expect(result.guide.cells[1]?.resolved.publicSteps).toEqual([]);
    expect(result.readmes[0]?.markdown).not.toContain("private-value");
    expect(result.readmes[0]?.markdown).not.toContain("test-value");
  });
});
