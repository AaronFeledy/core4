import { expect, it } from "bun:test";
import { isMapping, isString } from "@actions/workflow-parser";
import { Effect } from "effect";
import { parseActionLanguage, parseWorkflowLanguage } from "../src/language/parse.ts";

const workflow = (steps: string) =>
  `on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`;
it("preserves upstream tokens, on, scripts, and bounded alias provenance", async () => {
  const parsed = await Effect.runPromise(
    parseWorkflowLanguage(
      "ci.yml",
      workflow("      - &step\n        run: |\n          echo first\n          echo second\n      - *step\n"),
    ),
  );
  expect(isMapping(parsed.token)).toBe(true);
  if (!isMapping(parsed.token)) throw new Error("mapping required");
  const on = parsed.token.find("on");
  expect(on !== undefined && isString(on) && on.value).toBe("push");
  expect(parsed.workflow.jobs).toHaveLength(1);
  expect(parsed.aliasProvenance).toMatchObject([{ use: { line: 10 }, anchor: { line: 7 } }]);
});
it.each([
  ["duplicate", "on: push\non: pull_request\njobs: {}", "workflow-duplicate-key"],
  ["cycle", workflow("      - &a [*a]\n"), "yaml-alias-cycle"],
  ["unresolved", workflow("      - *missing\n"), "yaml-alias-unresolved"],
  ["unsupported", workflow("      - uses: x/y@v1\n        imaginary: private-value\n"), "workflow-invalid"],
])("rejects %s with bounded safe diagnostics", async (_name, content, code) => {
  const result = await Effect.runPromise(Effect.flip(parseWorkflowLanguage("ci.yml", content)));
  expect(String(result.code)).toBe(code);
  expect(JSON.stringify(result)).not.toContain("private-value");
});
it("parses action metadata using the pinned public action schema", async () => {
  const parsed = await Effect.runPromise(
    parseActionLanguage(
      "action.yml",
      "name: Local\ndescription: Local action\nruns:\n  using: composite\n  steps:\n    - run: echo hello\n      shell: bash\n",
    ),
  );
  expect(isMapping(parsed.token)).toBe(true);
});

// Run every reader fixture supported upstream, keeping reusable resolution and
// experimental syntax explicitly outside this pure single-file adapter.
import { readFileSync, readdirSync } from "node:fs";
import { parse as parseYaml } from "yaml";
const corpus = new URL("./fixtures/actions-language/workflows/", import.meta.url);
const unsupported = new Set(
  readFileSync(
    new URL("./fixtures/actions-language/workflow-upstream-unsupported.txt", import.meta.url),
    "utf8",
  ).split(/\r?\n/),
);
it("preserves the attributed upstream corpus bytes", () => {
  const root = new URL("./fixtures/actions-language/", import.meta.url);
  const entries = readFileSync(new URL("SHA256SUMS", root), "utf8").trim().split("\n");
  expect(entries.length).toBe(225);
  for (const entry of entries) {
    const [expected, path] = entry.split("  ");
    if (path === undefined) throw new Error("invalid fixture checksum manifest");
    expect(new Bun.CryptoHasher("sha256").update(readFileSync(new URL(path, root))).digest("hex")).toBe(
      expected ?? "",
    );
  }
});
for (const file of readdirSync(corpus).sort()) {
  const docs = readFileSync(new URL(file, corpus), "utf8").split(/\r?\n---\r?\n/);
  const options = parseYaml(docs[0] ?? "") as { "experimental-features"?: unknown; skip?: string[] };
  const reason = unsupported.has(file)
    ? "upstream-unsupported"
    : file.includes("reusable")
      ? "external-reusable-resolution"
      : options?.["experimental-features"] !== undefined
        ? "experimental-feature"
        : undefined;
  if (reason !== undefined) {
    it.skip(`upstream reader ${reason} ${file}`, () => {});
    continue;
  }
  it(`upstream reader ${file}`, async () => {
    const input = docs[1];
    if (input === undefined) throw new Error("missing corpus input");
    const expected = JSON.parse(docs[docs.length - 1] ?? "{}") as { errors?: unknown[]; jobs?: unknown[] };
    const result = await Effect.runPromise(Effect.result(parseWorkflowLanguage("ci.yml", input)));
    if (expected.errors !== undefined) {
      expect(result._tag).toBe("Failure");
      return;
    }
    expect(result._tag).toBe("Success");
    if (result._tag === "Success") {
      const actual = JSON.parse(JSON.stringify(result.success.workflow)) as Record<string, unknown>;
      const includeEvents =
        options?.skip?.some((x) => x.toLowerCase() === "go") &&
        options?.skip?.some((x) => x.toLowerCase() === "c#");
      const { events, ...withoutEvents } = actual;
      expect(includeEvents ? actual : withoutEvents).toEqual(expected);
    }
  });
}

import { Evaluator, Lexer, Parser, data } from "@actions/expressions";
import { BasicExpressionToken } from "@actions/workflow-parser/templates/tokens/basic-expression-token";
import { MappingToken } from "@actions/workflow-parser/templates/tokens/mapping-token";
import { SequenceToken } from "@actions/workflow-parser/templates/tokens/sequence-token";
import { StringToken } from "@actions/workflow-parser/templates/tokens/string-token";
import { evaluateTemplate } from "../src/language/template.ts";
it("bounds alias fanout and source names before upstream expansion", async () => {
  const text = `on: push\njobs: &a {one: &b [${"a,".repeat(60)}]}\nextra: [${"*a,".repeat(1000)}]\n`;
  const result = await Effect.runPromise(Effect.flip(parseWorkflowLanguage("bad\u001b", text)));
  expect(result.code).toBe("yaml-nodes");
  expect(result.source.file.length).toBeLessThan(3000);
  expect(result.source.file).not.toContain("\u001b");
});
it("preserves a complete long valid workflow path and explicitly rejects oversized source names", async () => {
  const file = `.github/workflows/${"x".repeat(251)}.yml`;
  expect(file.length).toBe(273);
  const parsed = await Effect.runPromise(parseWorkflowLanguage(file, workflow("      - run: echo hello\n")));
  expect(parsed.source.file).toBe(file);
  const invalid = await Effect.runPromise(
    Effect.flip(parseWorkflowLanguage(file, "on: push\non: pull_request\n")),
  );
  expect(invalid.source.file).toBe(file);
  const oversized = await Effect.runPromise(
    Effect.flip(parseWorkflowLanguage("x".repeat(4097), "on: push\n")),
  );
  expect(oversized.code).toBe("source-limit");
  expect(oversized.source.file.endsWith(" [source name truncated]")).toBe(true);
  expect(oversized.source.file.length).toBeLessThan(4200);
});
it("evaluates upstream multiline expression tokens with shared template budgets", async () => {
  const parsed = await Effect.runPromise(
    parseWorkflowLanguage("ci.yml", workflow("      - run: >\n          hello ${{ 'world' }}\n")),
  );
  const jobs = parsed.token.assertMapping("root").find("jobs")?.assertMapping("jobs");
  const job = jobs?.find("test")?.assertMapping("test");
  const run = job?.find("steps")?.assertSequence("steps").get(0).assertMapping("step").find("run");
  expect(run).toBeDefined();
  if (run instanceof BasicExpressionToken) {
    const expected = new Evaluator(
      new Parser(new Lexer(run.expression).lex().tokens, [], []).parse(),
      new data.Dictionary(),
    ).evaluate();
    const actual = await Effect.runPromise(
      evaluateTemplate(run, new data.Dictionary(), { source: parsed.source }),
    );
    expect(actual.coerceString()).toBe(expected.coerceString());
    // Pinned upstream known limitation: interpolation in a folded block retains indentation.
    expect(actual.coerceString()).toBe("          hello world\n");
  }
  const sequence = new SequenceToken(undefined, undefined, undefined);
  sequence.add(
    new BasicExpressionToken(
      undefined,
      undefined,
      "format('{0}{0}', '1234567890')",
      undefined,
      undefined,
      undefined,
    ),
  );
  sequence.add(
    new BasicExpressionToken(
      undefined,
      undefined,
      "format('{0}{0}', '1234567890')",
      undefined,
      undefined,
      undefined,
    ),
  );
  expect(
    (
      await Effect.runPromise(
        Effect.flip(
          evaluateTemplate(sequence, new data.Dictionary(), {
            source: { file: "synthetic.yml" },
            limits: { valueBytes: 60 },
          }),
        ),
      )
    ).code,
  ).toBe("expression-limit");
  const mapping = new MappingToken(undefined, undefined, undefined);
  mapping.add(
    new StringToken(undefined, undefined, "key", undefined),
    new StringToken(undefined, undefined, "value", undefined),
  );
  expect(
    JSON.stringify(
      await Effect.runPromise(
        evaluateTemplate(mapping, new data.Dictionary(), { source: { file: "synthetic.yml" } }),
      ),
      data.replacer,
    ),
  ).toBe('{"key":"value"}');
});

it("rejects source, expanded alias scalar bytes, and depth before upstream parsing", async () => {
  const oversized = "x".repeat(256 * 1024 + 1);
  expect((await Effect.runPromise(Effect.flip(parseWorkflowLanguage("ci.yml", oversized)))).code).toBe(
    "file-limit",
  );
  const repeated = `name: &value ${"x".repeat(2000)}\non: push\nenv:\n${Array.from({ length: 600 }, (_, i) => `  key${i}: *value`).join("\n")}\n`;
  expect((await Effect.runPromise(Effect.flip(parseWorkflowLanguage("ci.yml", repeated)))).code).toBe(
    "yaml-expansion-limit",
  );
  const deep = `${"[".repeat(65)}0${"]".repeat(65)}`;
  expect((await Effect.runPromise(Effect.flip(parseWorkflowLanguage("ci.yml", deep)))).code).toBe(
    "yaml-depth",
  );
});
