import { expect, test } from "bun:test";
import { Cause, DateTime, Effect, Exit, Option, Result, Schema } from "effect";

import { ProviderInternalError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import { bringUp } from "../src/podman/bring-up.ts";

const plan: AppPlan = {
  valueModel: 1,
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
  metadata: { resolvedAt: DateTime.makeUnsafe("2026-09-01T00:00:00Z"), source: "test", runtime: 4 },
  extensions: {},
};
const Request = Schema.Struct({
  Name: Schema.String,
  Labels: Schema.Record(Schema.String, Schema.String),
});

test.each([false, true])(
  "Podman apply reports actual creation, not existing volume success (existing=%s)",
  async (existing) => {
    const receipts: string[] = [];
    const result = await Effect.runPromise(
      bringUp(plan, {
        ctx: { providerId: "podman", remediation: "test" },
        onVolumeCreated: (fact) =>
          Effect.sync(() => {
            receipts.push(fact.nativeName);
          }),
        api: {
          request: (request) => {
            if (request.path !== "/volumes/create") return Effect.succeed({ status: 200, body: "{}" });
            return Schema.decodeUnknownEffect(Request)(request.body).pipe(
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
    expect(receipts).toEqual(existing ? [] : ["data"]);
    if (!existing) expect(result.createdVolumes?.[0]?.ownerRoot).toBe(AbsolutePath.make("/owner"));
  },
);

test.each([false, true])(
  "creation receipts finish before services start (receipt fails=%s)",
  async (fails) => {
    const name = ServiceName.make("web");
    const servicePlan: AppPlan = {
      ...plan,
      stores: [...plan.stores, { name: "cache", scope: "app", kind: "cache" }],
      services: {
        [name]: {
          name,
          type: "nginx",
          provider: plan.provider,
          primary: true,
          artifact: { kind: "ref", ref: "nginx:alpine" },
          environment: {},
          mounts: [],
          storage: [],
          endpoints: [],
          routes: [],
          dependsOn: [],
          hostAliases: [],
          metadata: plan.metadata,
          extensions: {},
        },
      },
    };
    const events: string[] = [];
    let running = false;
    const failure = new ProviderInternalError({
      providerId: "podman",
      operation: "receipt",
      message: "Persistence failed.",
      remediation:
        "Re-run the command after checking `podman` logs for the `receipt` failure; if it persists, report the error with that operation name.",
    });
    const result = await Effect.runPromise(
      Effect.result(
        bringUp(servicePlan, {
          ctx: { providerId: "podman", remediation: "test" },
          api: {
            request: (request) =>
              Effect.sync(() => {
                if (request.path === "/volumes/create") {
                  const body = Schema.decodeUnknownSync(Request)(request.body);
                  events.push(`create:${body.Name}`);
                  return { status: 201, body: JSON.stringify(body) };
                }
                if (request.path.endsWith("/start")) {
                  events.push("start");
                  running = true;
                  return { status: 204, body: "" };
                }
                if (request.path.endsWith("/json"))
                  return running
                    ? { status: 200, body: '{"Id":"web","State":{"Running":true}}' }
                    : { status: 404, body: "{}" };
                return { status: 201, body: "{}" };
              }),
          },
          onVolumeCreated: (fact) =>
            Effect.yieldNow.pipe(
              Effect.andThen(
                fails
                  ? Effect.fail(failure)
                  : Effect.sync(() => {
                      events.push(`receipt:${fact.nativeName}`);
                    }),
              ),
            ),
        }),
      ),
    );
    if (fails) {
      expect(Result.isFailure(result) && result.failure).toBe(failure);
      expect(events).toEqual(["create:data"]);
    } else {
      expect(Result.isSuccess(result)).toBe(true);
      expect(events).toEqual(["create:data", "receipt:data", "create:cache", "receipt:cache", "start"]);
    }
  },
);

test.each(["fails", "interrupts"] as const)(
  "a receipt that %s retains the networks and volume this apply created",
  async (outcome) => {
    // Given: an apply that creates its app network, then a volume whose receipt does not complete.
    const deleted: string[] = [];
    const networks = new Map<string, object>();
    const volumes = new Map<string, typeof Request.Type>();
    const failure = new ProviderInternalError({
      providerId: "podman",
      operation: "receipt",
      message: "No receipt.",
      remediation:
        "Re-run the command after checking `podman` logs for the `receipt` failure; if it persists, report the error with that operation name.",
    });
    const exit = await Effect.runPromiseExit(
      bringUp(plan, {
        ctx: { providerId: "podman", remediation: "test" },
        onVolumeCreated: () => (outcome === "fails" ? Effect.fail(failure) : Effect.interrupt),
        api: {
          request: (request) =>
            Effect.sync(() => {
              if (request.path === "/volumes/create") {
                const volume = Schema.decodeUnknownSync(Request)(request.body);
                volumes.set(volume.Name, volume);
                return { status: 201, body: JSON.stringify(volume) };
              }
              if (request.path === "/networks/create") {
                const body = Schema.decodeUnknownSync(
                  Schema.Struct({
                    Name: Schema.String,
                    Labels: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
                  }),
                )(request.body);
                networks.set(body.Name, { Id: body.Name, ...body });
                return { status: 201, body: "{}" };
              }
              if (request.path.startsWith("/networks/") && request.method === "GET") {
                const observed = networks.get(decodeURIComponent(request.path.slice("/networks/".length)));
                return { status: observed === undefined ? 404 : 200, body: JSON.stringify(observed ?? {}) };
              }
              if (request.method === "DELETE") {
                deleted.push(request.path);
                return { status: 204, body: "" };
              }
              return { status: 201, body: "{}" };
            }),
        },
      }),
    );
    // Then: the original outcome propagates without deleting established resources.
    expect(exit._tag).toBe("Failure");
    if (Exit.isFailure(exit)) {
      if (outcome === "fails") expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toBe(failure);
      else expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
    expect(networks.has("lando-creation")).toBe(true);
    expect(volumes.get("data")?.Labels["dev.lando.volume-instance"]).toBeDefined();
    expect(deleted).toEqual([]);
  },
);
