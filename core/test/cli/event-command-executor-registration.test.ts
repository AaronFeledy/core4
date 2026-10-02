import { expect, test } from "bun:test";
import { Context, Effect, Schema } from "effect";

import { RedactionService, createStandaloneRedactor, makeRedactionService } from "@lando/redaction/service";
import { RENDERER_CAPABILITIES_NONE } from "@lando/sdk/renderer";
import { Renderer } from "@lando/sdk/services";
import { makeEventCommandExecutor } from "../../src/cli/event-command-executor.ts";
import type { LandoCommandSpec } from "../../src/cli/spec/command-spec.ts";

test.each(["service", "standalone"] as const)(
  "event command registration protects retained output with %s redaction",
  async (mode) => {
    // Given
    const output: string[] = [];
    const secret = `executor-registration-${mode}`;
    const write = (body: string) =>
      Effect.sync(() => {
        output.push(body);
      });
    const renderer = {
      id: "plain",
      capabilities: RENDERER_CAPABILITIES_NONE,
      message: { info: write, warn: write, error: write },
      output: { stdout: write, stderr: write },
    } satisfies Context.Tag.Service<typeof Renderer>;
    const service = makeRedactionService({
      id: "empty",
      get: () => Effect.succeed(""),
      has: () => Effect.succeed(false),
      list: Effect.succeed([]),
    });
    const delegated: string[] = [];
    const base = Context.make(Context.GenericTag<unknown>("test/runtime"), {}).pipe(
      Context.add(Renderer, renderer),
    );
    const context =
      mode === "service"
        ? Context.add(base, RedactionService, {
            ...service,
            registerValues: (values) =>
              Effect.gen(function* () {
                delegated.push(...values);
                yield* service.registerValues(values);
              }),
          })
        : base;
    const spec = {
      id: "meta:test:registration",
      summary: "Register a resolved secret.",
      namespace: "meta",
      bootstrap: "none",
      resultSchema: Schema.Void,
      run: () =>
        Effect.gen(function* () {
          const redaction = yield* RedactionService;
          yield* redaction.registerValues([secret]);
          yield* (yield* Renderer).output.stdout(secret);
        }),
    } satisfies LandoCommandSpec;
    // When
    await Effect.runPromise(
      makeEventCommandExecutor(context, [{ spec, status: { kind: "implemented" } }]).run({
        command: spec.id,
        flags: {},
        args: {},
        argv: [],
        cwd: process.cwd(),
      }),
    );
    // Then
    expect(output).toEqual(["[redacted]"]);
    expect(delegated).toEqual(mode === "service" ? [secret] : []);
    expect(createStandaloneRedactor("secrets").redactString(secret)).toBe("[redacted]");
  },
);
