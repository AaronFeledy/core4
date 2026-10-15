import { Effect } from "effect";

import { RedactionService } from "@lando/redaction/service";
import { Renderer } from "@lando/sdk/services";

import type { PostInitIO } from "../../recipes/post-init/runtime.ts";
import { type ResultFormat, isEnvelopeResultFormat } from "../format-flags.ts";

/** Capture the command's renderer so recipe output shares its live-region journal. */
export const makeInitOutput = Effect.fnUntraced(function* (
  format: ResultFormat,
): Effect.fn.Return<PostInitIO, never, Renderer | RedactionService> {
  const renderer = yield* Renderer;
  const redaction = yield* RedactionService;
  const redactor = yield* redaction.forProfile("secrets", { sourceEnv: process.env });
  const machineOutput = isEnvelopeResultFormat(format) || format === "ndjson";
  return {
    out: (line) => {
      const text = redactor.redactString(line);
      return Effect.runPromise(
        renderer.id === "json"
          ? renderer.message.info(text)
          : machineOutput
            ? renderer.output.stderr(`${text}\n`)
            : renderer.output.stdout(`${text}\n`),
      );
    },
    err: (line) => {
      const text = redactor.redactString(line);
      return Effect.runPromise(
        renderer.id === "json" ? renderer.message.warn(text) : renderer.output.stderr(`${text}\n`),
      );
    },
  };
});
