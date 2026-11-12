import { Effect, Layer } from "effect";
import { FilesystemWatchIO } from "../../src/cli/commands/doctor-filesystem-watch-io.ts";

export const healthyFilesystemWatch = Layer.succeed(
  FilesystemWatchIO,
  FilesystemWatchIO.of({
    observe: Effect.succeed({
      limits: { max_user_watches: "65536", max_user_instances: "128", max_queued_events: "16384" },
      allocation: { stage: "complete" },
      cleanup: "complete",
      eventDelivery: "confirmed",
    }),
  }),
);
