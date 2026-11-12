import { expect, test } from "bun:test";
import { executionSiteAt } from "@lando/sdk/landofile/execution-sites";
import {
  type ExecutionSite,
  LandofileShape,
  authoringExpressionSlot,
  deriveAuthoringAst,
  executionSiteKey,
  getExecutionSite,
} from "@lando/sdk/schema";
import { SchemaAST as AST, Schema } from "effect";

test("execution annotations preserve shared authoring schema artifacts", () => {
  const command = Schema.Union([Schema.String, Schema.Array(Schema.String)]);
  const original = Schema.Struct({ first: command, second: command });
  const annotated = Schema.Struct({ first: executionSiteKey(command, "tooling-cmd"), second: command });
  const project = (schema: Schema.Top) =>
    Schema.toJsonSchemaDocument(
      Schema.make(
        deriveAuthoringAst(schema.ast, {
          partial: true,
          directives: true,
          slotFor: (kind) => authoringExpressionSlot(kind).ast,
        }),
      ),
    );
  expect(project(annotated)).toEqual(project(original));
});

const commandKeys = new Set([
  "command",
  "task",
  "entrypoint",
  "cmd",
  "cmds",
  "run",
  "defer",
  "sh",
  "test",
  "app",
  "artifact",
  "args",
  "dockerfile_inline",
  "dockerfileInline",
  "healthcheck",
  "readiness",
  "raw",
  "flags",
]);

test("every authored command string has execution semantics", () => {
  const missing = new Set<string>();
  const walk = (
    node: AST.AST,
    context: {
      readonly path: readonly string[];
      readonly command: boolean;
      readonly site?: ExecutionSite;
      readonly ancestors: ReadonlySet<AST.AST>;
    },
  ): void => {
    const ast = AST.toEncoded(node);
    if (context.ancestors.has(ast)) return;
    const site = getExecutionSite(ast) ?? getExecutionSite(node) ?? context.site;
    const ancestors = new Set(context.ancestors).add(ast);
    const next = (child: AST.AST, path = context.path, command = context.command) =>
      walk(child, { path, command, ancestors, ...(site === undefined ? {} : { site }) });
    switch (ast._tag) {
      case "String":
      case "Literal":
        if (
          (ast._tag === "String" || typeof ast.literal === "string") &&
          (context.command ||
            context.path.join(".") === "tooling.<name>" ||
            (context.path[0] === "events" && context.path.length === 3)) &&
          site === undefined
        )
          missing.add(context.path.join("."));
        return;
      case "Union":
        for (const member of ast.types) next(member);
        return;
      case "Suspend":
        next(ast.thunk());
        return;
      case "Declaration":
        for (const member of ast.typeParameters) next(member);
        return;
      case "Arrays":
        for (const item of [...ast.elements, ...ast.rest]) next(item, [...context.path, "<index>"]);
        return;
      case "Objects":
        for (const property of ast.propertySignatures)
          next(
            property.type,
            [...context.path, String(property.name)],
            context.command ||
              (commandKeys.has(String(property.name)) &&
                !(
                  context.path[0] === "tooling" &&
                  context.path.length === 2 &&
                  (property.name === "flags" || property.name === "args")
                )),
          );
        for (const index of ast.indexSignatures)
          next(index.type, [...context.path, "<name>"], context.command);
        return;
      default:
        return;
    }
  };
  walk(LandofileShape.ast, { path: [], command: false, ancestors: new Set() });
  expect(
    [...missing],
    `Tag these authored command paths with executionSite/executionSiteKey:\n${[...missing].join("\n")}`,
  ).toEqual([]);
});

test.each([
  [["services", "web", "command"], "service-command", []],
  [["services", "web", "command", 0], "service-command", [0]],
  [["services", "web", "entrypoint"], "service-entrypoint", []],
  [["services", "web", "entrypoint", 0], "service-entrypoint", [0]],
  [["services", "web", "healthcheck"], "healthcheck", []],
  [["services", "web", "healthcheck", "test", 0], "healthcheck", ["test", 0]],
  [["services", "web", "readiness", "command"], "healthcheck", ["command"]],
  [["services", "web", "build", "app"], "build-app", []],
  [["services", "web", "build", "app", 0], "build-app", [0]],
  [["services", "web", "build", "app", "run"], "build-app", ["run"]],
  [["services", "web", "build", "app", 0, "run"], "build-app", [0, "run"]],
  [["services", "web", "build", "app", "user"], "build-app", ["user"]],
  [["services", "web", "build", "artifact"], "build-artifact", []],
  [["services", "web", "build", "artifact", 0], "build-artifact", [0]],
  [["services", "web", "build", "artifact", "run"], "build-artifact", ["run"]],
  [["services", "web", "build", "artifact", 0, "run"], "build-artifact", [0, "run"]],
  [["services", "web", "build", "args", "TOKEN"], "build-arg", ["TOKEN"]],
  [["services", "web", "build", "args", 0], "build-arg", [0]],
  [["services", "web", "build", "dockerfile_inline"], "build-dockerfile", []],
  [["services", "web", "build", "dockerfileInline"], "build-dockerfile", []],
  [["tooling", "deploy"], "tooling-task", []],
  [["tooling", "deploy", "cmd"], "tooling-cmd", []],
  [["tooling", "deploy", "cmd", 0], "tooling-cmd", [0]],
  [["tooling", "deploy", "cmds", 0], "tooling-cmds", [0]],
  [["tooling", "deploy", "cmds", 0, "cmd"], "tooling-cmds", [0, "cmd"]],
  [["tooling", "deploy", "vars", "token", "sh"], "tooling-var", []],
  [["events", "post-start", 0], "event-step", []],
  [["events", "post-start", 0, "cmd"], "event-step", []],
  [["events", "post-start", 0, "defer"], "event-step", []],
  [["events", "post-start", 0, "command"], "event-lando-command", []],
  [["events", "post-start", 0, "task"], "event-lando-command", []],
  [["events", "post-start", 0, "raw", 0], "event-lando-command", [0]],
  [["events", "post-start", 0, "flags", "token"], "event-lando-command", ["token"]],
  [["events", "post-start", 0, "args", "token"], "event-lando-command", ["token"]],
] as const)("resolves an unambiguous execution site for %j", (path, site, relativePath) => {
  expect(executionSiteAt(path)).toEqual({ site, relativePath });
});

test.each([
  [["services", "web", "type"]],
  [["name"]],
  [["services", "web", "unknown"]],
  [["services", "web", "environment", "TOKEN"]],
  [["services", "web", "creds", "password"]],
  [["services", "web", "password"]],
  [["tooling", "deploy", "env", "TOKEN"]],
  [["tooling", "deploy", "vars", "token", "env", "TOKEN"]],
  [["toolingDefaults", "env", "TOKEN"]],
  [["events", "post-start", 0, "env", "TOKEN"]],
])("leaves secret-binding paths unclassified: %j", (path) => {
  expect(executionSiteAt(path)).toBeUndefined();
});
