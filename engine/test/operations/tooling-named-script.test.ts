import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { ToolingInputRevision, type ToolingInvocationInput } from "@lando/sdk/schema";
import { EnvironmentValueResolver, EventService, type LandoEvent } from "@lando/sdk/services";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect, Layer, Result } from "effect";
import { runBunShellTooling } from "../../src/operations/tooling-bun-script.ts";
import { testEnvironmentResolverLayer } from "../environment-values.ts";
import { recordingScriptEvents, withBunScript } from "./tooling-bun-script-support.ts";

const declaration =
  "# ---\n# flags:\n#   loud:\n#     boolean: true\n#     default: true\n#   empty:\n# args:\n#   first:\n#   second:\n# ---\n";

test("sparse named scripts preserve false, empty and omission without synthesized physical argv", async () => {
  // Given
  await withBunScript(
    `${declaration}echo "$LANDO_INPUT"\necho "$LANDO_FLAG_LOUD|$LANDO_FLAG_EMPTY|$LANDO_ARG_FIRST|$LANDO_ARG_SECOND|$1|$2"\n`,
    async (root) => {
      // When
      const result = await Effect.runPromise(
        runBunShellTooling(
          {
            name: "probe",
            input: { _tag: "NamedMaps", flags: { loud: false, empty: "" }, args: { second: "later" } },
          },
          root,
        ).pipe(Effect.provide(Layer.merge(PrivateFileAccessService.layer, testEnvironmentResolverLayer))),
      );
      // Then
      const [values, env] = result?.stdout.trimEnd().split("\n") ?? [];
      expect(JSON.parse(values ?? "")).toEqual({
        flags: { loud: false, empty: "" },
        args: { second: "later" },
      });
      expect(env).toBe("false|||later||");
    },
  );
});

const canary = 'innocuous-canary-"\\\n-value';
const failures: readonly {
  readonly label: string;
  readonly metadata?: string;
  readonly input: ToolingInvocationInput;
  readonly stale?: boolean;
  readonly tag: string;
}[] = [
  {
    label: "named wrong type",
    input: { _tag: "NamedMaps", flags: { mode: [canary] }, args: {} },
    tag: "ToolingInputError",
  },
  {
    label: "raw error before values",
    input: { _tag: "RawArgv", argv: ["--unknown", `--mode=${canary}`, "--mode=replaced"] },
    tag: "ToolingInputError",
  },
  {
    label: "raw error after values",
    input: { _tag: "RawArgv", argv: ["-m", canary, "--unknown"] },
    tag: "ToolingInputError",
  },
  {
    label: "choice error beside sensitive value",
    metadata: "#   choice:\n#     choices: [safe]\n",
    input: { _tag: "NamedMaps", flags: { mode: canary, choice: "bad" }, args: {} },
    tag: "ToolingInputError",
  },
  {
    label: "stale revision",
    input: { _tag: "NamedMaps", flags: { mode: canary }, args: {} },
    stale: true,
    tag: "ToolingInputError",
  },
  {
    label: "disabled before wrong type and stale",
    metadata: "# disabled: true\n",
    input: { _tag: "NamedMaps", flags: { mode: [canary] }, args: {} },
    stale: true,
    tag: "ToolingDisabledError",
  },
];

test.each(failures)(
  "protects $label before observable script effects",
  async ({ metadata = "", input, stale, tag }) => {
    // Given
    await withBunScript(
      `# ---\n# flags:\n#   mode:\n#     sensitive: true\n#     alias: m\n${metadata}# ---\necho ran > marker\n`,
      async (root) => {
        const events: LandoEvent[] = [];
        let sessions = 0;
        const redaction = makeRedactionService();
        // When
        const result = await Effect.runPromise(
          Effect.result(
            runBunShellTooling(
              {
                name: "probe",
                input,
                ...(stale ? { expectedInputRevision: ToolingInputRevision.make("stale") } : {}),
              },
              root,
            ),
          ).pipe(
            Effect.provide(PrivateFileAccessService.layer),
            Effect.provideService(RedactionService, redaction),
            Effect.provideService(EventService, recordingScriptEvents(events)),
            Effect.provideService(
              EnvironmentValueResolver,
              EnvironmentValueResolver.of({
                openSession: () =>
                  Effect.sync(() => {
                    sessions++;
                    return { resolveEnvironment: () => Effect.succeed({}) };
                  }),
              }),
            ),
          ),
        );
        const redactor = await Effect.runPromise(redaction.forProfile("secrets"));
        // Then
        expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: tag } });
        expect({ events, sessions, body: existsSync(join(root, "marker")) }).toEqual({
          events: [],
          sessions: 0,
          body: false,
        });
        expect(redactor.redactString(canary)).toBe("[redacted]");
        expect(redactor.redactString(JSON.stringify(canary))).not.toContain("innocuous-canary");
        expect(JSON.stringify(result)).not.toContain("innocuous-canary");
        expect(Result.isFailure(result)).toBe(true);
      },
    );
  },
);
