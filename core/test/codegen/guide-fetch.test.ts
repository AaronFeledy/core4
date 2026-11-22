import { expect, test } from "bun:test";
import { parseGuideScenarioAst, renderScenarioTest } from "../../../scripts/build-guide-scenarios.ts";
import { buildPublicTranscript } from "../../../scripts/guides/public-transcript.ts";

const source = "docs/guides/router-example.mdx";
const fetchStep =
  '<Fetch url="{{route:web}}/login?token=private-query" method="HEAD" headers={{ "Authorization": "private-header" }} expect={{ status: [301, 302], headers: { "Location": { regex: "private-location" } } }} />';
const guide = (body: string, layer = 'layer="e2e"') => `---
id: router-example
provider: test
---
<Guide>
<Scenario id="redirect" ${layer} render>
${body}
</Scenario>
</Guide>`;
const step = (leaf: string) => `<Step name="request">\n${leaf}\n</Step>`;

test.each([
  ['<Fetch url="/relative" expect={{ status: 200 }} />', "url"],
  ['<Fetch url="https://user:password@web.invalid" expect={{ status: 200 }} />', "url"],
  ['<Fetch url="{{route:web}}suffix" expect={{ status: 200 }} />', "url"],
  ['<Fetch url="http://web.invalid" method="POST" expect={{ status: 200 }} />', "method"],
  ['<Fetch url="http://web.invalid" expect={{ status: [] }} />', "expect.status"],
  ['<Fetch url="http://web.invalid" expect={{ status: 600 }} />', "expect.status"],
  ['<Fetch url="http://web.invalid" expect={{ status: 200, body: { exact: "x" } }} />', "expect.body.exact"],
])("rejects invalid Fetch props: %s", (leaf, code) => {
  expect(() => parseGuideScenarioAst(source, guide(step(leaf)))).toThrow(code);
});

test("Fetch needs a Step in an e2e scenario", () => {
  expect(() => parseGuideScenarioAst(source, guide(fetchStep))).toThrow(
    expect.objectContaining({
      code: "guide.structure.placement",
    }),
  );
  expect(() => parseGuideScenarioAst(source, guide(step(fetchStep), ""))).toThrow(
    expect.objectContaining({
      code: "guide.fetch.requires-e2e",
    }),
  );
  const skipped = `<Skip reason="This case does not run locally">\n${step(fetchStep)}\n</Skip>`;
  expect(() => parseGuideScenarioAst(source, guide(skipped, ""))).toThrow(
    expect.objectContaining({
      code: "guide.fetch.requires-e2e",
    }),
  );
});

test("Fetch emits an e2e context request and only public request metadata", () => {
  const ast = parseGuideScenarioAst(source, guide(step(fetchStep)));
  const [scenario] = ast.scenarios;
  if (!scenario) throw new Error("Missing parsed scenario");
  const code = renderScenarioTest(ast, scenario, undefined, "linux");
  expect(code).toContain("ScenarioContextFactory.e2e(");
  expect(code).toContain(
    'yield* context.fetch({"url":"{{route:web}}/login?token=private-query","method":"HEAD","headers":{"Authorization":"private-header"}})',
  );
  expect(code).toContain(".toContain(response.status)");
  expect(code).toContain('matchesExpected(response.headers["location"]');
  expect(buildPublicTranscript(ast, scenario, undefined)?.frames.at(-1)).toEqual({
    kind: "fetch",
    sourceFile: source,
    sourceLine: 8,
    commandDisplay: "HEAD {{route:web}}/login",
    resultSummary: "Expected HTTP 301 or 302",
  });
});
