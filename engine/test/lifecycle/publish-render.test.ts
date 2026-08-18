import { describe, expect, test } from "bun:test";
import { Context, Effect, Layer } from "effect";

import { createRedactor } from "@lando/sdk/secrets";
import { EventService } from "@lando/sdk/services";

import { makePublishRender } from "../../src/lifecycle/publish-render.ts";
import { EventRuntimeLive } from "../../src/services/event-service.ts";

describe("plugin render publication", () => {
  test("redacts and schema-decodes before publishing to EventService", async () => {
    // Given: a plugin publisher with one known secret in its redaction profile.
    const retained = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(EventRuntimeLive);
          const events = Context.get(context, EventService);
          const publish = makePublishRender(events, {
            forProfile: () => Effect.succeed(createRedactor("secrets", { values: ["topsecret"] })),
          });

          // When: a valid render event contains that secret.
          yield* publish({
            _tag: "notify.desktop",
            title: "Build topsecret completed",
            urgency: "success",
          });

          // Then: EventService retains only the decoded, redacted event.
          return yield* events.query("notify.desktop");
        }),
      ),
    );
    expect(retained).toHaveLength(1);
    expect(retained[0]?.title).not.toContain("topsecret");
    expect(retained[0]).toMatchObject({ _tag: "notify.desktop", urgency: "success" });
  });
});
