import { expect, test } from "bun:test";
import { parseMinimalYaml } from "@lando/paths/yaml-min";
import { validationIssue, validationIssuesFromCause } from "@lando/sdk/schema";
import { Effect, Result, Schema } from "effect";
import { runSetVerb, runUnsetVerb } from "../../src/config-write/verbs.ts";
import { CommandWarnings, makeCommandWarnings } from "../../src/landofile/command-warnings.ts";

const schema = Schema.Struct({
  name: Schema.String,
  port: Schema.optionalKey(Schema.Number),
  enabled: Schema.optionalKey(Schema.Boolean),
});
const fixture = () => {
  const writes: string[] = [];
  const warnings = makeCommandWarnings(true);
  return {
    writes,
    warnings,
    io: {
      file: "/tmp/config.yml",
      key: "port",
      dryRun: false,
      readText: Effect.succeed("# my comment\nname: 42\nport: invalid\nenabled: invalid\n"),
      parse: parseMinimalYaml,
      editCommand: "lando config edit",
      decode: (tree: unknown) =>
        Schema.decodeUnknownResult(schema)(tree, { errors: "all" }).pipe(
          Result.mapError(validationIssuesFromCause),
        ),
      writeText: (_file: string, text: string) =>
        Effect.sync(() => {
          writes.push(text);
        }),
    },
  };
};

test.each(["set", "unset"] as const)(
  "%s returns remaining issues and records one warning after persisting",
  async (verb) => {
    // Given three invalid fields in a commented document.
    const { io, writes, warnings } = fixture();
    // When repairing only the port.
    const outcome = await Effect.runPromise(
      (verb === "set" ? runSetVerb({ ...io, raw: "90" }) : runUnsetVerb(io)).pipe(
        Effect.provideService(CommandWarnings, warnings),
      ),
    );
    // Then the remaining issues are returned and warned once, without losing the comment.
    expect(outcome.remainingIssues?.map((issue) => issue.path)).toEqual([["name"], ["enabled"]]);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toStartWith("# my comment\n");
    const recorded = await Effect.runPromise(warnings.list);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.code).toBe("LANDO_CONFIG_PREEXISTING_ISSUES");
    expect(recorded[0]?.message).toContain("Fix or unset name");
    expect(recorded[0]?.message).toContain("Fix or unset enabled");
  },
);

test("rejects an unchanged invalid issue beneath the written parent", async () => {
  // Given a baseline with an invalid nested value.
  const { io, writes } = fixture();
  const issue = validationIssue(["router", "ports", 0], "Invalid port");
  // When writing a parent that leaves that same issue.
  const result = await Effect.runPromise(
    Effect.result(
      runSetVerb({
        ...io,
        key: "router",
        raw: '{"ports":[99999]}',
        type: "json",
        decode: () => Result.fail([issue]),
      }),
    ),
  );
  // Then unchanged identity does not exempt an issue under the target.
  expect(Result.isFailure(result)).toBe(true);
  expect(writes).toEqual([]);
});

test("rejects newly introduced issues outside the written key", async () => {
  // Given a decoder whose cross-field constraint depends on the written name.
  const { io, writes } = fixture();
  // When the candidate adds an issue on a different path.
  const result = await Effect.runPromise(
    Effect.result(
      runSetVerb({
        ...io,
        key: "name",
        raw: "new",
        decode: (tree) =>
          Result.fail([
            validationIssue(
              ["enabled"],
              typeof tree === "object" && tree !== null && "name" in tree && tree.name === "new"
                ? "New cross-field problem"
                : "Existing problem",
            ),
          ]),
      }),
    ),
  );
  // Then the new path/message identity blocks the write.
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result))
    expect(result.failure.issues).toEqual([validationIssue(["enabled"], "New cross-field problem")]);
  expect(writes).toEqual([]);
});

test("chooses the first acceptable interpretation despite unrelated issues", async () => {
  // Given an unrelated issue shared by both interpretations.
  const { io } = fixture();
  // When both text and numeric candidates are acceptable.
  const outcome = await Effect.runPromise(
    runSetVerb({ ...io, raw: "90", decode: () => Result.fail([validationIssue(["name"], "Invalid name")]) }),
  );
  // Then the original text wins rather than a later inferred value.
  expect(outcome.value).toBe("90");
});
