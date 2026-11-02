import { describe, expect, test } from "bun:test";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { CommandResultEnvelope } from "@lando/sdk/schema";
import { Effect, Layer, Option, Schema } from "effect";
import { formatBugReport } from "../../src/cli/bug-report";
import { CommandWarnings } from "../../src/cli/command-warnings";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary";

class StartError extends Schema.TaggedError<StartError>()("StartError", {
  message: Schema.String,
  remediation: Schema.String,
}) {}

const notice = "Start did not complete. Resources were left in place. Running: web private-notice-token.";

const failWithNotice = Effect.serviceOption(CommandWarnings).pipe(
  Effect.map(Option.getOrThrow),
  Effect.flatMap((warnings) => warnings.addFailureNotice(notice)),
  Effect.andThen(Effect.fail(new StartError({ message: "Start refused.", remediation: "Repair start." }))),
);

describe("failure notices", () => {
  for (const rendererMode of ["plain", "lando", "json"] as const) {
    test(`${rendererMode} prints the notice once, after the primary error`, async () => {
      // Given: a failing command that recorded a failure notice.
      const io = createBufferedRendererIO({ isTTY: rendererMode === "lando" });
      // When: the command boundary renders the failure.
      await runWithRendererHandling(failWithNotice, {
        runtime: Layer.empty,
        rendererMode,
        resultFormat: "text",
        command: "app:start",
        io,
        sourceEnv: {},
        extraRedactionTokens: ["private-notice-token"],
        setExitCode: () => undefined,
        formatError: (failure) =>
          formatBugReport({
            ...failure,
            context: { commandId: "app:start", cacheRoot: "/cache" },
            rendererMode,
          }),
      });
      // Then: the notice follows the complete diagnostic once, using the renderer's format.
      const text = io.stderr();
      const errorAt = text.indexOf("Start refused.");
      const noticeAt = text.indexOf("Start did not complete.");
      expect(errorAt).toBeGreaterThanOrEqual(0);
      expect(noticeAt).toBeGreaterThan(errorAt);
      expect(text.indexOf("Repair start.")).toBeGreaterThan(errorAt);
      expect(noticeAt).toBeGreaterThan(text.indexOf("Repair start."));
      expect(text.split("Start did not complete.")).toHaveLength(2);
      expect(text).not.toContain("private-notice-token");
      expect(text).toContain("[redacted]");
      if (rendererMode === "json") {
        const events = text
          .trimEnd()
          .split("\n")
          .map((line): unknown => JSON.parse(line));
        expect(events).toHaveLength(2);
        expect(events[0]).toMatchObject({ _tag: "message.error", body: "Start refused." });
        expect(events.at(-1)).toMatchObject({
          _tag: "event",
          event: "message.warn",
          payload: {
            _tag: "message.warn",
            body: notice.replace("private-notice-token", "[redacted]"),
          },
        });
      }
    });
  }

  test.each(["json", "yaml"] as const)(
    "%s output keeps the failure envelope free of the notice",
    async (resultFormat) => {
      // Given: a failing command that recorded a failure notice.
      const io = createBufferedRendererIO();
      // When: the boundary emits a machine envelope.
      await runWithRendererHandling(failWithNotice, {
        runtime: Layer.empty,
        rendererMode: "plain",
        resultFormat,
        command: "app:start",
        io,
        setExitCode: () => undefined,
        formatError: ({ error }) => String(error),
      });
      // Then: the envelope is schema-valid, unchanged, and no notice is written anywhere.
      const envelope = Schema.decodeUnknownSync(CommandResultEnvelope)(
        resultFormat === "json" ? JSON.parse(io.stdout()) : Bun.YAML.parse(io.stdout()),
      );
      expect(envelope.error).toEqual({
        _tag: "StartError",
        message: "Start refused.",
        remediation: "Repair start.",
      });
      expect(io.stdout()).not.toContain("Start did not complete");
      expect(io.stderr()).not.toContain("Start did not complete");
      expect(envelope.warnings).toEqual([]);
    },
  );
});
