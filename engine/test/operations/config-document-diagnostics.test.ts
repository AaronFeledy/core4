import { expect, test } from "bun:test";
import { parseMinimalYaml } from "@lando/paths/yaml-min";
import { type ValidationIssue, validationIssue } from "@lando/sdk/schema";
import { Effect, Result } from "effect";
import { runSetVerb, runUnsetVerb } from "../../src/config-write/verbs.ts";
import { recordConfigWarning } from "../../src/config/config-warnings.ts";
import { CommandWarnings, makeCommandWarnings } from "../../src/landofile/command-warnings.ts";

const io = {
  file: "/unused/config.yml",
  readText: Effect.succeed("port: 80\n"),
  parse: parseMinimalYaml,
  editCommand: "lando config edit",
  writeText: () => Effect.die("No-op/preview must not persist"),
};

test.each(["set", "unset"] as const)(
  "%s does not conflate equal diagnostics from different sources",
  async (verb) => {
    // Given identical path/messages whose physical source changes in the candidate.
    const baseline: ValidationIssue = {
      ...validationIssue(["other"], "Invalid value"),
      source: { layer: "canonical", file: "/app/.lando.yml", path: ["other"] },
    };
    const candidate: ValidationIssue = {
      ...baseline,
      source: { layer: "local", file: "/app/.lando.local.yml", path: ["other"] },
    };
    const document = {
      ...io,
      key: "port",
      dryRun: true,
      decode: () => Result.fail([candidate]),
      decodeBaseline: () => Result.fail([baseline]),
    };
    // When a mutation produces that new source issue.
    const result = await Effect.runPromise(
      Effect.result(verb === "set" ? runSetVerb({ ...document, raw: "90" }) : runUnsetVerb(document)),
    );
    // Then the candidate is blocked rather than treated as a preexisting unrelated issue.
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure.issues).toEqual([candidate]);
  },
);

test.each([true, false])(
  "only the selected interpretation emits diagnostics (accepted=%s)",
  async (accepted) => {
    // Given a decoder that emits a warning for every speculative interpretation and baseline.
    const warnings = makeCommandWarnings(true);
    const decode = (tree: unknown) =>
      Effect.gen(function* () {
        const port = typeof tree === "object" && tree !== null && "port" in tree ? tree.port : undefined;
        yield* recordConfigWarning({
          code: "LANDO_MESSAGE_WARN",
          message: String(port),
          context: { kind: typeof port, port: String(port) },
        });
        return port === 80 || (accepted && port === 90)
          ? Result.succeed(tree)
          : Result.fail([validationIssue(["port"], "Invalid port")]);
      });
    // When inference tries text, baseline, then number.
    const result = await Effect.runPromise(
      Effect.result(runSetVerb({ ...io, decode, key: "port", raw: "90", dryRun: true })).pipe(
        Effect.provideService(CommandWarnings, warnings),
      ),
    );
    // Then failed candidates and baselines cannot leak warnings.
    expect(Result.isSuccess(result)).toBe(accepted);
    expect((await Effect.runPromise(warnings.list)).map((warning) => warning.context)).toEqual(
      accepted ? [{ kind: "number", port: "90" }] : [],
    );
  },
);

test("an unchanged set emits its selected warning once", async () => {
  // Given a valid no-op whose validator reports a warning.
  const warnings = makeCommandWarnings(true);
  // When the authored number remains unchanged.
  const result = await Effect.runPromise(
    runSetVerb({
      ...io,
      key: "port",
      raw: "80",
      type: "number",
      dryRun: false,
      decode: (tree) =>
        recordConfigWarning({
          code: "LANDO_MESSAGE_WARN",
          message: "Selected",
          context: { selected: "true" },
        }).pipe(Effect.as(Result.succeed(tree))),
    }).pipe(Effect.provideService(CommandWarnings, warnings)),
  );
  // Then diagnostics survive the no-op without persistence.
  expect(result.changed).toBe(false);
  expect((await Effect.runPromise(warnings.list)).map((warning) => warning.context)).toEqual([
    { selected: "true" },
  ]);
});
