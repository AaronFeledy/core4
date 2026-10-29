import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseScriptFile } from "@lando/landofile/bun-sh-discovery";
import { EnvironmentValueResolver, EventService, type LandoEvent } from "@lando/sdk/services";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect, Layer, Result } from "effect";
import { runBunShellScript, runBunShellTooling } from "../../src/operations/tooling-bun-script.ts";
import { testEnvironmentResolverLayer } from "../environment-values.ts";
import { recordingScriptEvents, withBunScript } from "./tooling-bun-script-support.ts";

test("executes declared flags and positionals using original argv and named input values", async () => {
  // Given
  const script = [
    "# ---",
    "# flags:",
    "#   tone:",
    "#     alias: t",
    "#     default: welcome",
    "#   dry-run:",
    "#     boolean: true",
    "#     default: false",
    "#   absent:",
    "# args:",
    "#   name:",
    "#     required: true",
    "#   optional:",
    "# ---",
    `bun -e 'console.log(JSON.stringify({argv: process.argv.slice(1), input: JSON.parse(process.env.LANDO_INPUT), tone: process.env.LANDO_FLAG_TONE, dry: process.env.LANDO_FLAG_DRY_RUN, absent: process.env.LANDO_FLAG_ABSENT, optional: process.env.LANDO_ARG_OPTIONAL, name: process.env.LANDO_ARG_NAME}))' -- "$1" "$2"`,
  ].join("\n");
  await withBunScript(script, async (root) => {
    // When
    const result = await Effect.runPromise(
      runBunShellTooling(
        {
          name: "probe",
          input: { _tag: "RawArgv", argv: ["-t", "hello", "two words"] },
          env: { LANDO_FLAG_TONE: "spoof", LANDO_ARG_NAME: "spoof", LANDO_INPUT: "spoof" },
        },
        root,
      ).pipe(Effect.provide(Layer.merge(PrivateFileAccessService.layer, testEnvironmentResolverLayer))),
    );
    // Then
    expect(result?.exitCode).toBe(0);
    expect(JSON.parse(result?.stdout ?? "")).toEqual({
      argv: ["-t", "hello"],
      input: {
        flags: { tone: "hello", "dry-run": false },
        args: { name: "two words" },
      },
      tone: "hello",
      dry: "false",
      absent: "",
      optional: "",
      name: "two words",
    });
  });
});

test("keeps input defaults literal while resolving caller environment in one session", async () => {
  // Given
  const literal = "{{ env.NOT_EVALUATED }}-${secret:not-evaluated}";
  const script = [
    "# ---",
    "# flags:",
    "#   literal:",
    `#     default: '${literal}'`,
    "# ---",
    `bun -e 'console.log(JSON.stringify({literal: process.env.LANDO_FLAG_LITERAL, explicit: process.env.EXPLICIT, input: JSON.parse(process.env.LANDO_INPUT)}))'`,
  ].join("\n");
  await withBunScript(script, async (root) => {
    let sessions = 0;
    const environments: unknown[] = [];
    const resolver = EnvironmentValueResolver.of({
      openSession: () =>
        Effect.sync(() => {
          sessions++;
          return {
            resolveEnvironment: (env) =>
              Effect.sync(() => {
                environments.push(env);
                return { EXPLICIT: "resolved" };
              }),
          };
        }),
    });
    // When
    const result = await Effect.runPromise(
      runBunShellTooling({ name: "probe", env: { EXPLICIT: "authored" } }, root).pipe(
        Effect.provide(PrivateFileAccessService.layer),
        Effect.provideService(EnvironmentValueResolver, resolver),
      ),
    );
    // Then
    expect(JSON.parse(result?.stdout ?? "")).toEqual({
      literal,
      explicit: "resolved",
      input: { flags: { literal }, args: {} },
    });
    expect({ sessions, environments }).toEqual({ sessions: 1, environments: [{ EXPLICIT: "authored" }] });
  });
});

test("exports supplied boolean switches as literal true", async () => {
  // Given
  await withBunScript(
    '# ---\n# flags:\n#   verbose:\n#     boolean: true\n# ---\necho "$LANDO_FLAG_VERBOSE:$1"',
    async (root) => {
      // When
      const result = await Effect.runPromise(
        runBunShellTooling({ name: "probe", input: { _tag: "RawArgv", argv: ["--verbose"] } }, root).pipe(
          Effect.provide(Layer.merge(PrivateFileAccessService.layer, testEnvironmentResolverLayer)),
        ),
      );
      // Then
      expect(result?.stdout).toBe("true:--verbose\n");
    },
  );
});

const preflightCases = [
  { label: "disabled", metadata: "# disabled: true", argv: [], tag: "ToolingDisabledError" },
  { label: "non-host", metadata: "# service: :target", argv: [], tag: "NotImplementedError" },
  {
    label: "missing required input",
    metadata: "# args:\n#   name:\n#     required: true",
    argv: [],
    tag: "ToolingInputError",
  },
  {
    label: "invalid choice",
    metadata: "# flags:\n#   tone:\n#     choices: [hello]",
    argv: ["--tone=bad"],
    tag: "ToolingInputError",
  },
] as const;

for (const entry of ["direct", "discovery"] as const) {
  test.each(preflightCases)(
    `${entry} preflight refuses $label before session, progress, or body`,
    async (input) => {
      // Given
      const script = `# ---\n${input.metadata}\n# ---\necho executed > marker\n`;
      await withBunScript(script, async (root) => {
        let sessions = 0;
        const events: LandoEvent[] = [];
        const discovered = await Effect.runPromise(
          parseScriptFile(join(root, ".lando/scripts/probe.bun.sh"), "probe.bun.sh"),
        );
        const effect =
          entry === "direct"
            ? runBunShellScript(discovered, root, { input: { _tag: "RawArgv", argv: input.argv } })
            : runBunShellTooling({ name: "probe", input: { _tag: "RawArgv", argv: input.argv } }, root);
        // When
        const result = await Effect.runPromise(
          Effect.result(effect).pipe(
            Effect.provide(PrivateFileAccessService.layer),
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
            Effect.provideService(EventService, recordingScriptEvents(events)),
          ),
        );
        // Then
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe(input.tag);
          if (input.tag === "ToolingDisabledError")
            expect(result.failure).toMatchObject({ source: { path: discovered.path, task: "probe" } });
        }
        expect({ sessions, events, bodyRan: existsSync(join(root, "marker")) }).toEqual({
          sessions: 0,
          events: [],
          bodyRan: false,
        });
      });
    },
  );
}

test("shadows inherited and caller input namespaces without changing the parent environment", async () => {
  // Given
  const script =
    "# ---\n# ---\nbun -e 'console.log(JSON.stringify({input: JSON.parse(process.env.LANDO_INPUT), inherited: process.env.LANDO_FLAG_STALE, caller: process.env.LANDO_ARG_EXTRA, ordinary: process.env.ORDINARY}))'\n";
  await withBunScript(script, async (root) => {
    const operation = join(import.meta.dirname, "../../src/operations/tooling-bun-script.ts");
    const resolver = join(import.meta.dirname, "../environment-values.ts");
    const helper = `
      import { Effect, Layer } from "effect";
      import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
      import { testEnvironmentResolverLayer } from ${JSON.stringify(resolver)};
      import { runBunShellTooling } from ${JSON.stringify(operation)};
      const result = await Effect.runPromise(runBunShellTooling({name: "probe", input: {_tag: "RawArgv", argv: ["--raw", "two words"]}, env: {LANDO_INPUT: "spoof", LANDO_FLAG_STALE: "caller-stale", LANDO_ARG_EXTRA: "caller-extra", ORDINARY: "kept"}}, ${JSON.stringify(root)}).pipe(Effect.provide(Layer.merge(PrivateFileAccessService.layer, testEnvironmentResolverLayer))));
      console.log(JSON.stringify({result, inheritedAfter: process.env.LANDO_FLAG_STALE, inputAfter: process.env.LANDO_INPUT}));
    `;
    // When
    const child = Bun.spawn([process.execPath, "-e", helper], {
      env: { ...process.env, LANDO_FLAG_STALE: "parent-stale", LANDO_INPUT: "parent-input" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    // Then
    expect(code, stderr).toBe(0);
    const output = JSON.parse(stdout);
    expect(output.inheritedAfter).toBe("parent-stale");
    expect(output.inputAfter).toBe("parent-input");
    expect(JSON.parse(output.result.stdout)).toEqual({
      input: { flags: {}, args: {} },
      inherited: "",
      caller: "",
      ordinary: "kept",
    });
  });
});
