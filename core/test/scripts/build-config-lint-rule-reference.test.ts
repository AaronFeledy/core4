import { expect, test } from "bun:test";
import { CONFIG_LINT_RULES } from "@lando/sdk/schema";
import { compile } from "@mdx-js/mdx";
import remarkFrontmatter from "remark-frontmatter";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import {
  type ConfigLintRuleRegistry,
  configLintRuleAnchorId,
  renderConfigLintRuleReference,
} from "../../../scripts/build-config-lint-rule-reference.ts";

const sampleRules = {
  "landofile.hostname": {
    stages: ["resolve", "planning"],
    severities: ["error"],
    summary: "Each services.<name>.hostnames: entry is a plain DNS name after evaluation.",
    examplePaths: ["services.web.hostnames[0]"],
  },
  "env-file.read": {
    stages: ["resolve"],
    severities: ["error"],
    summary: "A declared env file is missing or cannot be read.",
    examplePaths: ["env_file[0]", "services.web.envFile[0]"],
  },
  "landofile.capability": {
    stages: ["resolve"],
    severities: ["error", "warning"],
    summary: "Provider capability checks against the offline declaration.",
    examplePaths: ["services.web.ports"],
  },
} as const satisfies ConfigLintRuleRegistry;

test("anchor ids replace dots with hyphens", () => {
  expect(configLintRuleAnchorId("landofile.hostname")).toBe("landofile-hostname");
  expect(configLintRuleAnchorId("healthcheck.bare-compose-marker")).toBe("healthcheck-bare-compose-marker");
  expect(configLintRuleAnchorId("env-file.read")).toBe("env-file-read");
  expect(configLintRuleAnchorId("router.bind-address-global-only")).toBe("router-bind-address-global-only");
});

test("renders one anchored table row per rule", () => {
  const page = renderConfigLintRuleReference(sampleRules);

  expect(page).toContain("| Rule | Severity | What it checks | Example paths | Stages |");
  expect(page).toContain(
    '| <span id="landofile-hostname">` landofile.hostname `</span> | error | Each services.&lt;name&gt;.hostnames: entry is a plain DNS name after evaluation. | ` services.web.hostnames[0] ` | ` resolve `, ` planning ` |',
  );
  expect(page).toContain('<span id="env-file-read">` env-file.read `</span>');
  expect(page).toContain("| error or warning |");
});

test("renders backtick spans in summaries as code", () => {
  const page = renderConfigLintRuleReference({
    "landofile.healthcheck": {
      stages: ["resolve"],
      severities: ["error"],
      summary: "An authored `kind: http` probe.",
      examplePaths: ["services.web.healthcheck.kind"],
    },
  });
  expect(page).toContain("An authored ` kind: http ` probe.");
});

test("renders every registry rule from CONFIG_LINT_RULES", async () => {
  const ids = Object.keys(CONFIG_LINT_RULES);
  const page = renderConfigLintRuleReference();
  for (const id of ids) expect(page).toContain(`<span id="${configLintRuleAnchorId(id)}">\` ${id} \`</span>`);
  await compile(page, { remarkPlugins: [remarkFrontmatter] });
});

test("emits compilable MDX without interpreting rule values as JSX or expressions", async () => {
  const hostile = "<broken {value} | `tick` & [link] *text*";
  const cases = [
    renderConfigLintRuleReference(sampleRules),
    renderConfigLintRuleReference({
      [hostile]: {
        stages: ["fragment"],
        severities: ["error"],
        summary: hostile,
        examplePaths: [hostile],
      },
      "landofile.hostname": sampleRules["landofile.hostname"],
    }),
  ];

  for (const page of cases) {
    await compile(page, { remarkPlugins: [remarkFrontmatter] });
    const body = page.replace(/\{\/\* GENERATED FILE\.[^\n]*\*\/\}/, "");
    const tree = unified().use(remarkParse).use(remarkMdx).use(remarkFrontmatter).parse(body);
    const nodes = JSON.stringify(tree);
    expect(nodes).not.toMatch(/"type":"mdx(?:JsxFlowElement|FlowExpression|TextExpression)"/);
    const jsx = [...nodes.matchAll(/"type":"mdxJsxTextElement","name":"([^"]*)"/g)].map((match) => match[1]);
    expect(jsx).toEqual(
      Array(page.split("\n").filter((line) => line.startsWith("| <span id=")).length).fill("span"),
    );
  }
});
