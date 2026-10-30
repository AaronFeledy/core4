import { describe, expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { layerPlainService } from "@lando/renderer/runtime";
import { ConfigError, InteractionCancelledError } from "@lando/sdk/errors";
import { ConfigTranslateDiagnostic, GlobalConfig } from "@lando/sdk/schema";
import { ConfigService, InteractionService } from "@lando/sdk/services";
import { Effect, Layer, Schema } from "effect";
import { makeInitReview, renderInitReview } from "../../src/cli/commands/init-review";
import { projectInitReviewRoutes } from "../../src/cli/commands/init-review-routes";
import type { ResultFormat } from "../../src/cli/format-flags";
import { makePromiseInteractionPrompter } from "../../src/interaction/prompter";
import { makeInteractionService } from "../../src/interaction/service";
import { reviewWith } from "./init-review-fixtures";

const setup = async (
  options: {
    readonly format?: ResultFormat;
    readonly yes?: boolean;
    readonly nonInteractive?: boolean;
    readonly tty?: boolean;
    readonly configError?: ConfigError;
  } = {},
) => {
  const io = createBufferedRendererIO();
  const stdin = Object.assign(new PassThrough(), { isTTY: options.tty ?? true });
  const stderr = Object.assign(
    new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
    { isTTY: options.tty ?? true },
  );
  const service = makeInteractionService({ stdin, stderr });
  const interaction = makePromiseInteractionPrompter(service);
  const snapshot = Schema.decodeUnknownSync(GlobalConfig)({});
  const redaction = makeRedactionService();
  let loads = 0;
  const config = ConfigService.of({
    load: Effect.suspend(() => {
      loads++;
      return options.configError === undefined ? Effect.succeed(snapshot) : Effect.die(options.configError);
    }),
    get: (key) => Effect.succeed(snapshot[key]),
  });
  const onPrepared = await Effect.runPromise(
    Effect.gen(function* () {
      const redaction = yield* RedactionService;
      yield* redaction.registerValues(["private-token"]);
      return yield* makeInitReview({
        format: options.format ?? "text",
        ...(options.yes === undefined ? {} : { yes: options.yes }),
        ...(options.nonInteractive === undefined ? {} : { nonInteractive: options.nonInteractive }),
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerPlainService(io),
          Layer.succeed(RedactionService, redaction),
          Layer.succeed(InteractionService, service),
          Layer.succeed(ConfigService, config),
        ),
      ),
    ),
  );
  return { onPrepared, interaction, stdin, io, loads: () => loads };
};

describe("prepared init presentation", () => {
  test("renders exact inventory and paths without a clean-path confirmation", async () => {
    const harness = await setup();
    const review = {
      ...reviewWith({ services: { web: { type: "node:22", routes: ["chosen.example"] } } }),
      outputs: [{ destination: "docs/日本語  two spaces.txt", mode: 0o644, digest: "sha256:x", bytes: 4 }],
    };
    if (!harness.onPrepared) throw new TypeError("Expected an interactive review hook");
    await harness.onPrepared(review, {
      interaction: {
        ...harness.interaction,
        confirm: async () => {
          throw new TypeError("Unexpected confirmation");
        },
      },
    });
    expect(harness.io.stderr()).toContain(review.appRoot);
    expect(harness.io.stderr()).toContain(review.outputs[0]?.destination ?? "missing");
    expect(harness.io.stderr()).toContain("https://chosen.example");
    expect(harness.io.stdout()).toBe("");
    expect(harness.loads()).toBe(1);
  });

  test("creates the hook without loading configuration", async () => {
    const harness = await setup();
    expect(harness.onPrepared).toBeDefined();
    expect(harness.loads()).toBe(0);
  });

  test.each([
    { format: "json" },
    { format: "yaml" },
    { format: "ndjson" },
    { yes: true },
    { nonInteractive: true },
    { tty: false },
  ] satisfies readonly Parameters<typeof setup>[0][])(
    "does no review configuration work for %j",
    async (options) => {
      const harness = await setup(options);
      expect(harness.onPrepared).toBeUndefined();
      expect(harness.loads()).toBe(0);
      expect(harness.io.stderr()).toBe("");
    },
  );

  test("defaults reduced scaffolding to decline using the questionnaire's buffered reader", async () => {
    const harness = await setup();
    harness.stdin.end("chosen\n\n");
    await harness.interaction.promptAll([{ name: "name", type: "text", message: "Name" }], {
      mode: "interactive",
    });
    const review = { ...reviewWith(), skippedScaffold: ["package.json", "server.js"] };
    if (!harness.onPrepared) throw new TypeError("Expected an interactive review hook");
    await expect(harness.onPrepared(review, { interaction: harness.interaction })).rejects.toBeInstanceOf(
      InteractionCancelledError,
    );
  });

  test("continues a reduced scaffold only after its one affirmative decision", async () => {
    const harness = await setup();
    const review = { ...reviewWith(), skippedScaffold: ["package.json"] };
    let decisions = 0;
    if (!harness.onPrepared) throw new TypeError("Expected an interactive review hook");
    await harness.onPrepared(review, {
      interaction: {
        ...harness.interaction,
        confirm: async (spec) => {
          decisions++;
          expect(spec.default).toBe(false);
          return true;
        },
      },
    });
    expect(decisions).toBe(1);
  });

  test("propagates keyboard cancellation rather than falling back to approval", async () => {
    const harness = await setup();
    const review = { ...reviewWith(), skippedScaffold: ["package.json"] };
    const cancellation = new InteractionCancelledError({ message: "cancelled", remediation: "retry" });
    if (!harness.onPrepared) throw new TypeError("Expected an interactive review hook");
    await expect(
      harness.onPrepared(review, {
        interaction: {
          ...harness.interaction,
          confirm: async () => {
            throw cancellation;
          },
        },
      }),
    ).rejects.toBe(cancellation);
  });

  test("checks cancellation before configuration or output", async () => {
    const harness = await setup();
    if (!harness.onPrepared) throw new TypeError("Expected an interactive review hook");
    await expect(
      harness.onPrepared(reviewWith(), { interaction: harness.interaction, signal: AbortSignal.abort() }),
    ).rejects.toBeInstanceOf(InteractionCancelledError);
    expect(harness.loads()).toBe(0);
    expect(harness.io.stderr()).toBe("");
  });

  test("propagates invocation config failures instead of substituting a guessed domain", async () => {
    const harness = await setup({
      configError: new ConfigError({ message: "broken config", remediation: "repair config" }),
    });
    if (!harness.onPrepared) throw new TypeError("Expected an interactive review hook");
    await expect(
      harness.onPrepared(reviewWith(), { interaction: harness.interaction }),
    ).rejects.toMatchObject({ _tag: "ConfigError" });
    expect(harness.io.stderr()).toBe("");
  });

  test("redacts arbitrary summary values and never emits environment or command bodies", async () => {
    const harness = await setup();
    const review = {
      ...reviewWith({
        services: {
          web: {
            type: "node:22",
            environment: { PASSWORD: "private-token" },
            command: ["private-command"],
            routes: ["private-token.example"],
          },
        },
      }),
      appRoot: "/tmp/private-token",
    };
    if (!harness.onPrepared) throw new TypeError("Expected an interactive review hook");
    await harness.onPrepared(review, { interaction: harness.interaction });
    expect(harness.io.stderr()).not.toContain("private-token");
    expect(harness.io.stderr()).not.toContain("private-command");
    expect(harness.io.stderr()).not.toContain("PASSWORD");
  });

  test.each([80, 120])("preserves exact long CJK paths at %i columns", (columns) => {
    const review = { ...reviewWith(), appRoot: `/tmp/${"日本語  ".repeat(30)}` };
    const output = renderInitReview({
      review,
      routes: projectInitReviewRoutes(review, {}),
      decorated: true,
      columns,
      redact: (value) => value,
    });
    expect(output.split("\n")).toContain(`  ${review.appRoot}`);
  });

  test("renders redacted diagnostic detail and remediation before the decision", async () => {
    // Given diagnostics containing registered secrets and a pending reduced-scaffold decision.
    const harness = await setup();
    const review = {
      ...reviewWith(),
      skippedScaffold: ["package.json"],
      diagnostics: [
        Schema.decodeUnknownSync(ConfigTranslateDiagnostic)({
          kind: "needs-review",
          sourceId: "fixture",
          keyPath: ["services", "web"],
          message: "DIAGNOSTIC_TOKEN private-token",
          remediation: "REMEDIATION_TOKEN private-token",
        }),
      ],
    };
    if (!harness.onPrepared) throw new TypeError("Expected an interactive review hook");
    let decisionOutput = "";

    // When preparation reaches confirmation without publishing any files.
    await expect(
      harness.onPrepared(review, {
        interaction: {
          ...harness.interaction,
          confirm: async () => {
            decisionOutput = harness.io.stderr();
            return false;
          },
        },
      }),
    ).rejects.toBeInstanceOf(InteractionCancelledError);

    // Then the decision already has both concrete fields, without the secret.
    expect(decisionOutput).toContain("DIAGNOSTIC_TOKEN");
    expect(decisionOutput).toContain("REMEDIATION_TOKEN");
    expect(decisionOutput).not.toContain("private-token");
    expect(harness.io.stdout()).toBe("");
  });
});
