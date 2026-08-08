import { randomBytes } from "node:crypto";
import { DateTime, Effect } from "effect";

import { PostHostProxyCallEvent, PreHostProxyCallEvent } from "@lando/sdk/events";
import type { AppRef } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";

const now = () => DateTime.unsafeMake(new Date().toISOString());

export const makeHostProxyCallId = (): string => `hp-${Date.now()}-${randomBytes(4).toString("hex")}`;

export const publishRejected = (input: {
  readonly app: AppRef;
  readonly callId: string;
  readonly callerService: string;
  readonly depth: number;
  readonly failureDetail: string;
}) =>
  Effect.gen(function* () {
    const events = yield* EventService;
    const request = { kind: "runLando" };
    yield* events.publish(
      PreHostProxyCallEvent.make({
        app: input.app,
        callId: input.callId,
        request,
        callerService: input.callerService,
        depth: input.depth,
        timestamp: now(),
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
        timestamp: now(),
      }),
    );
  });
