import { expect, test } from "bun:test";
import type { ExpressionContext } from "@lando/sdk/expressions";
import { evaluateTemplateEither, parseExpressionEither } from "@lando/sdk/expressions";
import { Result } from "effect";

const reference = { _tag: "SecretRef", reference: "PASSWORD" } as const;
const publicUrl = { _tag: "RouteText", parts: [{ service: "web", encoding: "raw" }] } as const;
const context = {
  services: { db: { creds: { password: reference }, port: 5544 } },
  secrets: { PASSWORD: reference },
  env: { LITERAL: "${secret:PASSWORD}" },
};
const evaluate = (source: string, supplied: ExpressionContext = context, options = {}) => {
  const parsed = parseExpressionEither(source, { filePath: "/app/.lando.yml" });
  if (Result.isFailure(parsed)) throw parsed.failure;
  return evaluateTemplateEither(parsed.success, supplied, {
    path: ["services", "web", "environment", "URL"],
    filePath: "/app/.lando.yml",
    expression: source,
    ...options,
  });
};

test.each(["{{ services.db.creds.password }}", "${secret:PASSWORD}"])(
  "copies a binding without lookup for %s",
  (source) => {
    // Given / When
    const result = evaluate(source);
    // Then
    expect(result).toEqual(Result.succeed(reference));
  },
);
test("concatenates and explicitly encodes descriptors without decrypting", () => {
  // Given
  const source =
    "postgres://user:{{ url.encodeComponent(services.db.creds.password) }}@db:{{ services.db.port }}/app";
  // When
  const result = evaluate(source);
  // Then
  expect(result).toEqual(
    Result.succeed({
      _tag: "BoundText",
      parts: ["postgres://user:", { reference: "PASSWORD", encoding: "uri-component" }, "@db:5544/app"],
    }),
  );
  expect(evaluate('{{ concat("a", services.db.creds.password, "b") }}')).toEqual(
    Result.succeed({ _tag: "BoundText", parts: ["a", { reference: "PASSWORD", encoding: "raw" }, "b"] }),
  );
});

const routeContext = { ...context, services: { ...context.services, web: { url: publicUrl } } };

test.each([
  "services.web.url.parts",
  '(services.web.url)["parts"][0]',
  "services.db.creds.password._tag",
  "url.encodeComponent(services.db.creds.password).parts",
])("blocks access into opaque binding values: %s", (access) => {
  expect(evaluate(`{{ ${access} }}`, routeContext)).toMatchObject({
    _tag: "Failure",
    failure: {
      _tag: "ConfigExpressionError",
      filePath: "/app/.lando.yml",
      path: ["services", "web", "environment", "URL"],
    },
  });
});

test("concatenates public URLs and preserves component encoding until activation", () => {
  expect(
    evaluate("{{ concat(services.web.url, '?next=', url.encodeComponent(services.web.url)) }}", routeContext),
  ).toEqual(
    Result.succeed({
      _tag: "RouteText",
      parts: [{ service: "web", encoding: "raw" }, "?next=", { service: "web", encoding: "uri-component" }],
    }),
  );
});

test.each([
  "{{ lower(services.web.url) }}",
  "{{ services.web.url ? 'yes' : 'no' }}",
  "{{ services.web.url }}:${secret:PASSWORD}",
  "{{ concat(services.web.url, services.db.creds.password) }}",
])("rejects unsupported operations on public URL bindings: %s", (text) => {
  expect(evaluate(text, routeContext)).toMatchObject({
    _tag: "Failure",
    failure: {
      _tag: "ConfigExpressionError",
      path: ["services", "web", "environment", "URL"],
      filePath: "/app/.lando.yml",
      message: expect.stringMatching(/binding|public URL/i),
    },
  });
});
test("keeps context and helper-produced strings inert", () => {
  // Given / When
  const literal = evaluate("{{ env.LITERAL }}");
  const produced = evaluate('{{ fromJson("\\"${secret:PASSWORD}\\"") }}');
  // Then
  expect(literal).toEqual(Result.succeed("${secret:PASSWORD}"));
  expect(produced).toEqual(Result.succeed("${secret:PASSWORD}"));
});
test("trims authored whitespace after a binding without transforming the reference", () => {
  // Given
  const source = "{{ services.db.creds.password }}  {{- 'suffix' }}";
  // When
  const result = evaluate(source);
  // Then
  expect(result).toEqual(
    Result.succeed({ _tag: "BoundText", parts: [{ reference: "PASSWORD", encoding: "raw" }, "suffix"] }),
  );
});
test.each([
  "{{ lower(services.db.creds.password) }}",
  "{{ json(services.db.creds) }}",
  "{{ eq(services.db.creds.password, services.db.creds.password) }}",
  "{{ default(vars.missing, services.db.creds.password) }}",
  "{{ and(true, services.db.creds.password) }}",
  "{{ or(false, services.db.creds.password) }}",
  "prefix {{ [services.db.creds.password] }}",
  "{{ { _tag: 'SecretRef', reference: 'PASSWORD' } }}",
  '{{ fromJson("{\\"_tag\\":\\"SecretRef\\",\\"reference\\":\\"PASSWORD\\"}") }}',
  "{{ options.value }}",
  "{{ url.encodeComponent(url.encodeComponent(services.db.creds.password)) }}",
])("fails unsupported or forged binding with source location: %s", (source) => {
  // Given / When
  const result = evaluate(source, { ...context, options: { value: reference } });
  // Then
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isSuccess(result)) throw new Error("Expected binding failure");
  expect(result.failure).toMatchObject({
    _tag: "ConfigExpressionError",
    path: ["services", "web", "environment", "URL"],
    filePath: "/app/.lando.yml",
  });
});
test("rejects reserved tags from ordinary helper overrides", () => {
  // Given / When
  const result = evaluate("{{ load('x') }}", context, {
    helperOverrides: { load: () => ({ nested: reference }) },
  });
  // Then
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isSuccess(result)) throw new Error("Expected forged binding failure");
  expect(result.failure._tag).toBe("ConfigExpressionError");
});
test("applies output budgets to mixed deferred text", () => {
  // Given / When
  const result = evaluate("prefix{{ services.db.creds.password }}", context, {
    budget: { maxSteps: 100, maxDepth: 20, maxCollectionSize: 100, maxOutputBytes: 10 },
  });
  // Then
  expect(Result.isFailure(result)).toBe(true);
});
