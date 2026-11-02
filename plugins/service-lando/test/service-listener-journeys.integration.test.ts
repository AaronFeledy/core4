import { afterAll, beforeAll, describe, test } from "bun:test";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { Effect } from "effect";
import { acquireListenerApp } from "./support/listener-cli.ts";
import { mailpitJourney, minioJourney } from "./support/listener-journeys.ts";
import { assertListenerCompletion, listenerPrerequisites } from "./support/listener-prerequisites.ts";

const strict = process.env.LANDO_TEST_LISTENERS_STRICT === "1";
const socket = resolveLiveProviderSocket();
const missing = listenerPrerequisites({
  socket: socket !== undefined,
  binary: process.env.LANDO_SCENARIO_E2E_BINARY,
  image: process.env.LANDO_TEST_MINIO_IMAGE,
});
const completed: string[] = [];
const cases = [
  { id: "mailpit-default", moved: false, journey: mailpitJourney },
  { id: "mailpit-moved", moved: true, journey: mailpitJourney },
  { id: "minio-default", moved: false, journey: minioJourney },
  { id: "minio-moved", moved: true, journey: minioJourney },
] as const;

describe.serial("real service listener journeys", () => {
  beforeAll(() => {
    if (missing.length > 0) {
      const message = `Listener prerequisites:\n${missing.join("\n")}`;
      if (strict) throw new Error(message);
      console.warn(message);
    }
  });
  afterAll(() => {
    console.log(`SERVICE_LISTENER_ACCEPTANCE completed=${completed.length}/4 cases=${completed.join(",")}`);
    if (strict) assertListenerCompletion(completed);
  });
  for (const item of cases) {
    test.skipIf(!strict && missing.length > 0)(
      item.id,
      async () => {
        if (socket === undefined || missing.length > 0) throw new Error(missing.join("\n"));
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const app = yield* acquireListenerApp(socket.socketPath);
              yield* item.journey(app, item.moved).pipe(Effect.timeout("6 minutes"));
            }),
          ),
        );
        completed.push(item.id);
      },
      480_000,
    );
  }
});
