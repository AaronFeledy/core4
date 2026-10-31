import { expect, test } from "bun:test";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { CommandResultEnvelope } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";
import { Effect, Layer, Schema } from "effect";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary";

for (const resultFormat of ["json", "yaml"] as const) {
  test.each([false, true])(
    `lando ${resultFormat} envelopes realize only desktop notifications (TTY=%s)`,
    async (isTTY) => {
      // Given an envelope command with an independently configured narration terminal.
      const io = createBufferedRendererIO({ isTTY });

      // When it publishes a notification alongside task and message narration.
      await runWithRendererHandling(
        Effect.gen(function* () {
          const events = yield* EventService;
          yield* events.publish({ _tag: "notify.desktop", title: "Done", urgency: "success" });
          yield* events.publish({
            _tag: "task.start",
            taskId: "quiet-task",
            label: "Quiet task",
            timestamp: "2026-10-30T00:00:00.000Z",
          });
          yield* events.publish({
            _tag: "message.info",
            body: "Quiet message",
            timestamp: "2026-10-30T00:00:00.000Z",
          });
          return {};
        }),
        {
          runtime: Layer.empty,
          rendererMode: "lando",
          resultFormat,
          command: "meta:version",
          resultSchema: Schema.Struct({}),
          io,
          render: () => undefined,
          formatError: () => "unexpected failure",
          setExitCode: () => undefined,
        },
      );

      // Then stderr contains only OSC 99 on a terminal, and stdout stays an envelope.
      expect(io.stderr()).toBe(isTTY ? "\u001b]99;i=lando:d=0:p=body;Done\u0007" : "");
      const value = resultFormat === "json" ? JSON.parse(io.stdout()) : Bun.YAML.parse(io.stdout());
      expect(Schema.decodeUnknownSync(CommandResultEnvelope)(value).ok).toBe(true);
    },
  );
}
