import { expect, test } from "bun:test";
import { DateTime, Effect, Schema } from "effect";

import { AbsolutePath, AppId, type AppPlan, ProviderId } from "@lando/sdk/schema";
import { bringUp } from "../src/podman/bring-up.ts";

const plan: AppPlan = {
  id: AppId.make("creation"),
  name: "creation",
  slug: "creation",
  root: AbsolutePath.make("/owner"),
  provider: ProviderId.make("podman"),
  identity: { appRoot: AbsolutePath.make("/owner"), ownerKey: "owner" },
  services: {},
  routes: [],
  networks: [],
  stores: [{ name: "data", scope: "app", kind: "data" }],
  fileSync: [],
  metadata: { resolvedAt: DateTime.unsafeMake("2026-09-01T00:00:00Z"), source: "test", runtime: 4 },
  extensions: {},
};
const Request = Schema.Struct({
  Name: Schema.String,
  Labels: Schema.Record({ key: Schema.String, value: Schema.String }),
});

test.each([false, true])(
  "Podman apply reports actual creation, not existing volume success (existing=%s)",
  async (existing) => {
    const result = await Effect.runPromise(
      bringUp(plan, {
        ctx: { providerId: "podman", remediation: "test" },
        api: {
          request: (request) => {
            if (request.path !== "/volumes/create") return Effect.succeed({ status: 200, body: "{}" });
            return Schema.decodeUnknown(Request)(request.body).pipe(
              Effect.orDie,
              Effect.map((body) => ({
                status: 201,
                body: JSON.stringify({
                  ...body,
                  Labels: existing
                    ? { ...body.Labels, "dev.lando.volume-instance": "existing" }
                    : body.Labels,
                }),
              })),
            );
          },
        },
      }),
    );
    expect(result.createdVolumes).toHaveLength(existing ? 0 : 1);
    if (!existing) expect(result.createdVolumes?.[0]?.ownerRoot).toBe(AbsolutePath.make("/owner"));
  },
);
