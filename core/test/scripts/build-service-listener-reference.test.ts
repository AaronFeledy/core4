import { expect, test } from "bun:test";
import { compile } from "@mdx-js/mdx";
import remarkFrontmatter from "remark-frontmatter";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { renderServiceListenerReference } from "../../../scripts/build-service-listener-reference.ts";

test.each([
  ["mongodb", "Authored launcher argument", "--port 27017"],
  ["tomcat", "Custom image setting", '<Connector port="8080">'],
  ["tomcat", "Custom image file", "server.xml"],
  ["python/flask", "Host defaults", "FLASK_RUN_HOST=0.0.0.0"],
])("renders %s %s from the real registry", (key, field, value) => {
  // Given: the shipped registry, including family and variant contracts.
  // When
  const page = renderServiceListenerReference();
  const section = page.split(new RegExp(`#{2,3} \u0060 ${key} \u0060\n`))[1]?.split(/\n#{2,3} /)[0];
  // Then
  expect(section).toContain(`| ${field} | \u0060 ${value} \u0060 |`);
});

test.each([
  ["localstack", "List bind variable", "` GATEWAY_LISTEN ` (comma-separated wildcard binds)"],
  [
    "solr",
    "Derived secondary listeners",
    "loopback stop listener (STOP&#95;PORT): ` port - 1000 ` unless ` STOP_PORT ` is authored (loopback only)",
  ],
  [
    "rabbitmq",
    "Derived secondary listeners",
    "distribution listener: ` port + 20000 ` unless ` RABBITMQ_DIST_PORT ` is authored",
  ],
])("renders %s %s mechanisms", (key, field, value) => {
  const page = renderServiceListenerReference();
  const section = page.split(new RegExp(`#{2,3} \u0060 ${key} \u0060\n`))[1]?.split(/\n#{2,3} /)[0];
  expect(section).toContain(`| ${field} | ${value} |`);
});

test("emits compilable MDX without interpreting contract values as JSX or expressions", async () => {
  // Given: real contracts plus values containing MDX and table syntax.
  const hostile = "<broken {value} | `tick` & [link] *text*";
  const cases = [
    renderServiceListenerReference(),
    renderServiceListenerReference({
      [hostile]: {
        daemon: hostile,
        port: 1234,
        variables: [hostile],
        bindVariables: [hostile],
        listVariable: hostile,
        derived: [{ use: hostile, offset: -1000, variable: hostile, loopback: true }],
        hostDefaults: { [hostile]: hostile },
        reserved: [{ port: 1235, use: hostile }],
        when: hostile,
        launcher: { setting: () => hostile },
        image: { setting: () => hostile, file: hostile },
      },
    }),
  ];
  // When / Then: compilation succeeds, and only the generated banner is an MDX expression.
  for (const page of cases) {
    await compile(page, { remarkPlugins: [remarkFrontmatter] });
    const body = page.replace(/\{\/\* GENERATED FILE\.[^\n]*\*\/\}/, "");
    const tree = unified().use(remarkParse).use(remarkMdx).use(remarkFrontmatter).parse(body);
    expect(JSON.stringify(tree)).not.toMatch(/"type":"mdx(?:Jsx|FlowExpression|TextExpression)/);
  }
});
