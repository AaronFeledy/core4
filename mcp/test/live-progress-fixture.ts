import { makeRedactionService } from "@lando/redaction/service";
import { Effect, Schema } from "effect";
import { makeStreamFrameSink } from "../src/progress";

const frameSchema = Schema.Struct({
  _tag: Schema.Literals(["stdout", "stderr"]),
  chunk: Schema.String,
  service: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
});

export const progressFixture = Effect.fnUntraced(function* () {
  const service = makeRedactionService();
  const frames: Array<typeof frameSchema.Type> = [];
  const owner = makeStreamFrameSink(
    (frame) =>
      Effect.sync(() => {
        frames.push(Schema.decodeUnknownSync(frameSchema)(frame));
      }),
    yield* service.forProfile("secrets", { sourceEnv: {} }),
    yield* service.payloadValues({ sourceEnv: {} }),
  );
  return {
    sink: owner.sink,
    owner,
    frames,
    service,
    text: () => frames.map((frame) => frame.chunk).join(""),
  };
});

export const flushProgress = (owner: ReturnType<typeof makeStreamFrameSink>) => owner.finish();
