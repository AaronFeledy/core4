import { expect, test } from "bun:test";
import type { ExecutableCommandSpec } from "@lando/sdk/plugins";
import { Effect, Schema } from "effect";
import { resolveBuiltInCommand } from "../../src/cli/built-in-command-registry.ts";
import { type CommandHelpEntry, renderCommandHelp } from "../../src/cli/cli-help.ts";
import { bold } from "../../src/cli/help-style.ts";
import { renderPluginOwnedCommandHelp } from "../../src/cli/plugin-owned-command-input.ts";

test("#2040 command help lists positional metadata after flags in declared order", () => {
  const entry = {
    spec: {
      id: "example:deploy",
      summary: "Deploy an artifact.",
      flags: { force: { type: "boolean" } },
      args: {
        target: { description: "Deployment target.", options: ["local", "remote"], required: true },
        artifact: { description: "Artifact path." },
        extra: {},
      },
    },
    status: { kind: "implemented" },
  } satisfies CommandHelpEntry;

  const help = renderCommandHelp(entry);

  expect(help.split("\nARGUMENTS\n")[1]?.split("\n\n")[0]).toBe(
    `  target ${entry.spec.args.target.description} (local, remote) [required]\n` +
      `  artifact ${entry.spec.args.artifact.description}\n  extra`,
  );
  expect(help).toContain("\nFLAGS\n");
  expect(help.indexOf("\nARGUMENTS\n")).toBeGreaterThan(help.indexOf("\nFLAGS\n"));
});

test.each([undefined, {}])("omits ARGUMENTS when args are %j", (args) => {
  const help = renderCommandHelp({
    spec: { id: "example:inspect", summary: "Inspect an artifact.", ...(args === undefined ? {} : { args }) },
    status: { kind: "implemented" },
  });

  expect(help).not.toContain("\nARGUMENTS\n");
});

test.each(["exec", "init"])("#2040 built-in %s help renders its declared argument descriptions", (id) => {
  const entry = resolveBuiltInCommand(id);
  if (entry === undefined) throw new Error(`Missing built-in ${id}`);

  const help = renderCommandHelp(entry);

  const argumentsBody = help.split("\nARGUMENTS\n")[1]?.split("\n\n")[0];
  expect(argumentsBody).toBeDefined();
  for (const [name, arg] of Object.entries(entry.spec.args ?? {})) {
    expect(argumentsBody).toContain(`  ${name} ${arg.description}`);
  }
});

test("styles the ARGUMENTS heading like other command sections", () => {
  const entry = {
    spec: { id: "example:inspect", summary: "Inspect an artifact.", args: { file: {} } },
    status: { kind: "implemented" },
  } satisfies CommandHelpEntry;

  const help = renderCommandHelp(entry, { styled: true });

  expect(help).toContain(`\n${bold("ARGUMENTS")}\n`);
});

test.each([false, true])("#2040 plugin argument help preserves descriptions with required=%s", (required) => {
  const spec = {
    id: "example:dump",
    namespace: "example",
    bootstrap: "plugins",
    args: {
      file: { type: "string", description: "Dump file, or - for stdio.", required, multiple: true },
    },
    resultSchema: Schema.Void,
    run: () => Effect.void,
  } satisfies ExecutableCommandSpec;

  const help = renderPluginOwnedCommandHelp(spec);

  expect(help.split("\nARGUMENTS\n")[1]?.split("\n\n")[0]).toBe(
    `  file ${spec.args.file.description}${required ? " [required]" : ""}`,
  );
  expect(help).toContain(required ? "<FILE>" : "[FILE]");
});
