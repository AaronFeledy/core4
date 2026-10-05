import { expect, test } from "bun:test";
import { Result } from "effect";

import { expressionScopeMembers, parseExpressionEither } from "@lando/sdk/expressions";

const parse = (source: string) => {
  const parsed = parseExpressionEither(source, {
    filePath: "/app/.lando.yml",
    bareShellParameters: "preserve",
  });
  if (Result.isFailure(parsed)) throw parsed.failure;
  return parsed.success;
};

test("lists the static members read under one scope across every interpolation", () => {
  const ast = parse(
    "postgresql://{{ services.database.creds.user }}:{{ services['database'].creds.password }}@db/{{ services.other.creds.database }}-{{ app.name }}",
  );
  const result = expressionScopeMembers(ast, "services");
  expect([...result.members].sort()).toEqual(["database", "other"]);
  expect(result.analyzable).toBe(true);
  expect(expressionScopeMembers(ast, "app").members).toEqual(new Set(["name"]));
  expect(expressionScopeMembers(ast, "proxy").members).toEqual(new Set());
});

test("walks helper arguments, conditionals, and collections", () => {
  const ast = parse(
    "{{ default(services.primary.creds.password, services.replica.creds.password) }} {{ eq(app.name, 'x') ? services.a.creds.user : [services.b.creds.user] }}",
  );
  expect([...expressionScopeMembers(ast, "services").members].sort()).toEqual([
    "a",
    "b",
    "primary",
    "replica",
  ]);
});

test("reports a computed or bare member as unanalyzable", () => {
  expect(expressionScopeMembers(parse("{{ services[app.name].creds.user }}"), "services").analyzable).toBe(
    false,
  );
  expect(expressionScopeMembers(parse("{{ services }}"), "services").analyzable).toBe(false);
  expect(expressionScopeMembers(parse("{{ services.database }}"), "services")).toEqual({
    members: new Set(["database"]),
    analyzable: true,
  });
});

test.each([
  ["{{ (services)['database'].creds.user }}", ["database"], true],
  ["{{ { user: services.database.creds.user } }}", ["database"], true],
  ["{{ app[services.database.creds.user] }}", ["database"], true],
  ["{{ (app)[services.database.creds.user] }}", ["database"], true],
  ["{{ services[services.selector.name] }}", ["selector"], false],
  ["{{ services[0] }}", [], false],
  ["{{ services.database[app.name] }}", ["database"], true],
  ["{{ services.database }} {{ services }}", ["database"], false],
  ["${VAR} ${secret:token} {{ services.database }}", ["database"], true],
  ["${VAR} ${secret:token}", [], true],
  ["{{ map(services.database, app.helper) }}", ["database"], true],
] as const)("analyzes member reads in %s", (source, members, analyzable) => {
  // Given
  const ast = parse(source);

  // When
  const result = expressionScopeMembers(ast, "services");

  // Then
  expect(result).toEqual({ members: new Set(members), analyzable });
});

test("accepts an expression node without a template", () => {
  // Given
  const ast = {
    kind: "Access",
    target: { kind: "Path", head: "services", segments: [] },
    segments: [{ type: "key", key: "database" }],
  } as const;

  // When
  const result = expressionScopeMembers(ast, "services");

  // Then
  expect(result).toEqual({ members: new Set(["database"]), analyzable: true });
});
