import { randomBytes } from "node:crypto";
import { DateTime, Effect } from "effect";

import { PostHostProxyCallEvent, PreHostProxyCallEvent } from "@lando/sdk/events";
import type { AppRef } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";

export const makeHostProxyCallId = (): string => `hp-${randomBytes(12).toString("hex")}`;

export const publishRejected = Effect.fnUntraced(function* (input: {
  readonly app: AppRef;
  readonly callId: string;
  readonly callerService: string;
  readonly depth: number;
  readonly failureDetail: string;
}) {
  const events = yield* EventService;
  const request = { kind: "runLando" };
  yield* events.publish(
    PreHostProxyCallEvent.make({
      app: input.app,
      callId: input.callId,
      request,
      callerService: input.callerService,
      depth: input.depth,
      timestamp: yield* DateTime.now,
    }),
  );
  yield* events.publish(
    PostHostProxyCallEvent.make({
      app: input.app,
      callId: input.callId,
      request,
      callerService: input.callerService,
      depth: input.depth,
      outcome: "failure",
      failureDetail: input.failureDetail,
      timestamp: yield* DateTime.now,
    }),
  );
});
