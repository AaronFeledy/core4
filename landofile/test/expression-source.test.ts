import { expect, test } from "bun:test";
import { parseExpressionEither } from "@lando/sdk/expressions";
import { Result } from "effect";
import { templateSource } from "../src/expression-source.ts";

const parse = (text: string) => {
  const parsed = parseExpressionEither(text, { filePath: "test.yml" });
  if (Result.isFailure(parsed)) throw parsed.failure;
  return parsed.success;
};

test.each([
  ["member access on a call", "{{ url.parse(services.web.url).hostname }}"],
  ["index access on a call", '{{ url.parse(services.web.url)["hostname"] }}'],
  ["access on a grouped path", "{{ (vars.site).hostname }}"],
  ["access on a grouped conditional", "{{ (vars.a ? vars.b : vars.c).name }}"],
])("prints %s as authored", (_name, text) => {
  expect(templateSource(parse(text))).toBe(text);
});
