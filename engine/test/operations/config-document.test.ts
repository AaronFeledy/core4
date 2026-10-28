import { expect, test } from "bun:test";
import { parseMinimalYaml } from "@lando/paths/yaml-min";
import { ConfigError } from "@lando/sdk/errors";
import { type ValidationIssue, validationIssue, validationIssuesFromCause } from "@lando/sdk/schema";
import { Effect, Result, Schema } from "effect";
import type { ConfigDocument } from "../../src/config-write/document.ts";
import { runEditVerb, runSetVerb } from "../../src/config-write/verbs.ts";

const file = "/tmp/config-document.yml";
const fixture = (source = "name: app\nport: 80\n") => {
  const writes: string[] = [];
  const parsed: string[] = [];
  const io = {
    file,
    readText: Effect.succeed(source),
    parse: (text: string) => {
      parsed.push(text);
      return parseMinimalYaml(text);
    },
    editCommand: "lando config edit",
    decode: (tree: unknown) =>
      Schema.decodeUnknownResult(
        Schema.Struct({ name: Schema.String, port: Schema.optionalKey(Schema.Number) }),
      )(tree).pipe(Result.mapError(validationIssuesFromCause)),
    writeText: (_file: string, text: string) =>
      Effect.sync(() => {
        writes.push(text);
      }),
  } satisfies ConfigDocument<Result.Result<unknown, readonly ValidationIssue[]>, never, never>;
  return { io, writes, parsed };
};

test.each([false, true])(
  "set skips serialization and writes when authored trees match (dryRun=%s)",
  async (dryRun) => {
    // Given formatting that must remain untouched, including nested collection values.
    const source = '# keep\nname: "app"\nport: 80\noptions: {"a": [1, 2], "b": true}\n';
    const { io, writes, parsed } = fixture(source);
    // When an equivalent authored tree has a different mapping-key order.
    const result = await Effect.runPromise(
      runSetVerb({
        ...io,
        key: "options",
        raw: '{"b":true,"a":[1,2]}',
        type: "json",
        dryRun,
      }),
    );
    // Then no serialization round-trip or persistence occurs.
    expect(result.changed).toBe(false);
    expect(parsed).toEqual([source]);
    expect(writes).toEqual([]);
  },
);

test("set still rejects an unchanged invalid target", async () => {
  // Given the existing value violates the schema.
  const { io, writes } = fixture("name: app\nport: invalid\n");
  // When setting that same authored value.
  const result = await Effect.runPromise(
    Effect.result(
      runSetVerb({
        ...io,
        key: "port",
        raw: "invalid",
        dryRun: false,
      }),
    ),
  );
  // Then equality does not bypass validation.
  expect(Result.isFailure(result)).toBe(true);
  expect(writes).toEqual([]);
});

test("set retains unrelated baseline issues on an unchanged valid target", async () => {
  // Given an unchanged target and a repairable issue elsewhere.
  const { io, writes } = fixture();
  const issue = validationIssue(["other"], "Invalid value");
  // When the target remains valid but the document has a baseline issue.
  const result = await Effect.runPromise(
    runSetVerb({
      ...io,
      key: "name",
      raw: "app",
      dryRun: false,
      decode: () => Result.fail([issue]),
    }),
  );
  // Then the no-op is truthful without discarding repair diagnostics.
  expect(result.changed).toBe(false);
  expect(result.remainingIssues).toEqual([issue]);
  expect(writes).toEqual([]);
});

test("set propagates fatal validation policy failures even when unchanged", async () => {
  // Given a policy error distinct from candidate validation issues.
  const { io, writes } = fixture();
  const error = new ConfigError({ message: "Policy failed", path: file, remediation: "Repair policy." });
  // When the equal candidate reaches admission.
  const result = await Effect.runPromise(
    Effect.result(
      runSetVerb({
        ...io,
        key: "name",
        raw: "app",
        dryRun: false,
        afterDecode: () => error,
      }),
    ),
  );
  // Then the typed fatal failure is preserved and nothing is persisted.
  expect(result).toEqual(Result.fail(error));
  expect(writes).toEqual([]);
});

test.each([
  { source: "name: app\n", edited: "name: app\n", dryRun: false, changed: false },
  { source: "name: app\n", edited: '# retained\nname: "app"\n', dryRun: false, changed: true },
  { source: "name: app\n", edited: "name: next\n", dryRun: true, changed: true },
  { source: "", edited: "name: global\n", dryRun: false, changed: true },
  { source: "name: [broken", edited: "name: repaired\n", dryRun: false, changed: true },
])("edit compares exact persisted text and permits malformed-original repair (%j)", async (input) => {
  // Given persisted bytes distinct from any editor seed.
  const { io, writes, parsed } = fixture(input.source);
  const opened: string[] = [];
  // When the editor returns its exact buffer.
  const result = await Effect.runPromise(
    runEditVerb({
      ...io,
      dryRun: input.dryRun,
      openEditor: (source) =>
        Effect.sync(() => {
          opened.push(source);
          return { kind: "edited" as const, content: input.edited };
        }),
    }),
  );
  // Then only the returned buffer is parsed, and changed non-preview bytes alone are persisted.
  expect(result).toEqual({ changed: input.changed, dryRun: input.dryRun, valid: true });
  expect(opened).toEqual([input.source]);
  expect(parsed).toEqual([input.edited]);
  expect(writes).toEqual(input.changed && !input.dryRun ? [input.edited] : []);
});

test.each([false, true])(
  "edit validates exact returned text before admitting a write (dryRun=%s)",
  async (dryRun) => {
    // Given an adapter whose text validator rejects a buffer that tree decoding would accept.
    const { io, writes, parsed } = fixture();
    const text = '# keep\nname: "new"\n';
    const validated: string[] = [];
    const issue = validationIssue(["name"], "Rejected replacement");
    // When the exact-text validator rejects the editor buffer.
    const result = await Effect.runPromise(
      Effect.result(
        runEditVerb({
          ...io,
          dryRun,
          openEditor: () => Effect.succeed({ kind: "edited" as const, content: text }),
          validateText: (content) => {
            validated.push(content);
            return Result.fail([issue]);
          },
        }),
      ),
    );
    // Then the text hook is authoritative and neither tree parsing nor writing runs.
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure.issues).toEqual([issue]);
    expect(validated).toEqual([text]);
    expect(parsed).toEqual([]);
    expect(writes).toEqual([]);
  },
);

test("edit validates unchanged text instead of silently accepting an invalid no-op", async () => {
  // Given invalid persisted text that the editor leaves untouched.
  const source = "name: 42\n";
  const { io, writes } = fixture(source);
  // When the editor saves the unchanged invalid buffer.
  const result = await Effect.runPromise(
    Effect.result(
      runEditVerb({
        ...io,
        dryRun: false,
        openEditor: () => Effect.succeed({ kind: "edited" as const, content: source }),
      }),
    ),
  );
  // Then validation blocks the operation even though no bytes changed.
  expect(Result.isFailure(result)).toBe(true);
  expect(writes).toEqual([]);
});

test.each([undefined, { kind: "no-editor" }, { kind: "failed", reason: "exit 7", exitCode: 7 }] as const)(
  "edit preserves typed editor failures (%j)",
  async (edited) => {
    // Given a missing or failed editor.
    const { io, writes, parsed } = fixture();
    // When edit is requested.
    const result = await Effect.runPromise(
      Effect.result(
        runEditVerb({
          ...io,
          dryRun: false,
          openEditor: edited === undefined ? undefined : () => Effect.succeed(edited),
        }),
      ),
    );
    // Then the editor failure stays typed and cannot reach validation or persistence.
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("LandofileWriteValidationError");
      expect(result.failure.file).toBe(file);
    }
    expect(parsed).toEqual([]);
    expect(writes).toEqual([]);
  },
);

test.each(["editor", "validation", "admission"] as const)(
  "edit propagates fatal %s failures",
  async (stage) => {
    // Given a fatal failure distinct from recoverable schema issues.
    const { io, writes } = fixture();
    const error = new ConfigError({ message: "Fatal failure", path: file, remediation: "Repair source." });
    // When the selected boundary fails.
    const result = await Effect.runPromise(
      Effect.result(
        runEditVerb({
          ...io,
          dryRun: false,
          openEditor: () =>
            stage === "editor"
              ? Effect.fail(error)
              : Effect.succeed({ kind: "edited" as const, content: "name: app\n" }),
          validateText: (text) =>
            stage === "validation" ? Effect.fail(error) : io.decode(parseMinimalYaml(text)),
          afterDecode: () => (stage === "admission" ? error : undefined),
        }),
      ),
    );
    // Then the original typed failure propagates without a write.
    expect(result).toEqual(Result.fail(error));
    expect(writes).toEqual([]);
  },
);
