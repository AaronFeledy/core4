import { Effect, Stream } from "effect";

import { persistVerifiedStream } from "@lando/sdk/verified-stream";

const payload = new TextEncoder().encode("STDOUT-DUMP-ONLY");

await Effect.runPromise(
  Effect.scoped(
    persistVerifiedStream({
      body: Stream.fromIterable([payload]),
      destinationPath: "/dev/stdout",
    }),
  ),
);
