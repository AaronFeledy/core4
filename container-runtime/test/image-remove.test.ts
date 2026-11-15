import { expect, test } from "bun:test";
import { mapFailures } from "@lando/sdk/command-result";
import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import { ProviderId } from "@lando/sdk/schema";
import { Effect } from "effect";
import { removeContainerArtifact } from "../src/image-remove.ts";
import { FakeEngine } from "./support/fake-engine.ts";

const ctx = { providerId: "podman", remediation: "Start the container runtime and retry.", env: {} };
const ref = "lando-build-0123abcd-podman-web-0123456789abcdef01234567";
const base = `${ref}-base`;
const remove = (engine: FakeEngine, target = ref, pruneParents?: boolean) =>
  removeContainerArtifact(
    {
      request: (input) =>
        engine.request(input).pipe(
          mapFailures((error) =>
            error instanceof ProviderUnavailableError || error instanceof ProviderInternalError
              ? error
              : new ProviderInternalError({
                  ...ctx,
                  operation: "request",
                  message: error.message,
                  cause: error,
                }),
          ),
        ),
    },
    {
      providerId: ProviderId.make(ctx.providerId),
      ref: target,
      ...(pruneParents === undefined ? {} : { pruneParents }),
    },
    ctx,
  );

test("removing an unknown artifact is absent and idempotent", async () => {
  const engine = new FakeEngine();
  expect(await Effect.runPromise(remove(engine))).toEqual({ kind: "absent" });
  expect(await Effect.runPromise(remove(engine))).toEqual({ kind: "absent" });
});

test("removes only the requested ref even when a similarly named image exists", async () => {
  const engine = new FakeEngine();
  engine.assets.images.set("example/app", { Id: "app", Size: 1 });
  engine.assets.images.set("example/app-base", { Id: "app-base", Size: 1 });
  expect(await Effect.runPromise(remove(engine, "example/app"))).toEqual({ kind: "removed" });
  expect(engine.assets.images.has("example/app-base")).toBe(true);
});

test("an in-use image leaves similarly named images untouched", async () => {
  const engine = new FakeEngine();
  engine.assets.images.set(base, { Id: "base", Size: 1 });
  engine.fail("image.delete", { status: 409, body: '{"message":"image is used by container web"}' });
  expect(await Effect.runPromise(remove(engine))).toEqual({
    kind: "in-use",
    containers: [],
    reason: "image is used by container web",
  });
  expect(engine.assets.images.has(base)).toBe(true);
  expect(engine.requests).toHaveLength(2);
});

test.each([true, false])(
  "removes exactly the requested image when its presence is %s",
  async (finalPresent) => {
    const engine = new FakeEngine();
    if (finalPresent) engine.assets.images.set(ref, { Id: "final", Size: 1 });
    engine.assets.images.set(base, { Id: "base", Size: 1 });
    expect(await Effect.runPromise(remove(engine))).toEqual({ kind: finalPresent ? "removed" : "absent" });
    expect(engine.assets.images.has(ref)).toBe(false);
    expect(engine.assets.images.has(base)).toBe(true);
    expect(engine.httpRequests.map((request) => request.path)).toEqual([
      `/images/${encodeURIComponent(ref)}?noprune=true`,
    ]);
  },
);

test("a conflict on an unrelated image does not affect removal", async () => {
  const engine = new FakeEngine();
  engine.assets.images.set(ref, { Id: "final", Size: 1 });
  engine.assets.images.set(base, { Id: "base", Size: 1 });
  engine.onRequest = (request) => {
    if (new URL(request.path, "http://fake-engine").pathname === `/images/${encodeURIComponent(base)}`)
      engine.fail("image.delete", { status: 409, body: '{"message":"base is in use"}' });
  };
  expect(await Effect.runPromise(remove(engine))).toEqual({ kind: "removed" });
  expect(engine.assets.images.has(ref)).toBe(false);
  expect(engine.assets.images.has(base)).toBe(true);
});

test("transport failures identify the removal operation", async () => {
  const engine = new FakeEngine();
  engine.fail(
    "image.delete",
    new ProviderUnavailableError({ ...ctx, operation: "request", message: "offline" }),
  );
  const result = await Effect.runPromise(Effect.result(remove(engine)));
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ProviderUnavailableError", operation: "removeArtifact" },
  });
});

test("unexpected engine statuses fail with an internal removal error", async () => {
  const engine = new FakeEngine();
  engine.fail("image.delete", { status: 500, body: '{"message":"storage failure"}' });
  const result = await Effect.runPromise(Effect.result(remove(engine)));
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ProviderInternalError", operation: "removeArtifact" },
  });
});

test.each([undefined, false, true])(
  "parent pruning is explicit when pruneParents is %s",
  async (pruneParents) => {
    const engine = new FakeEngine();
    await Effect.runPromise(remove(engine, "example/app", pruneParents));
    const url = new URL(engine.httpRequests[0]?.path ?? "", "http://fake-engine");
    expect(url.searchParams.get("noprune")).toBe(pruneParents ? null : "true");
    expect(url.searchParams.has("force")).toBe(false);
  },
);

test.each(["example/app", "sha256:abcdef"])("in-use %s reports only its container names", async (target) => {
  const engine = new FakeEngine();
  engine.seedContainer("using-web", { Image: target.replace(/^sha256:/u, "") });
  engine.seedContainer("unrelated", { Image: "another/image" });
  engine.fail("image.delete", { status: 409, body: '{"message":"image is in use"}' });
  expect(await Effect.runPromise(remove(engine, target))).toEqual({
    kind: "in-use",
    containers: ["using-web"],
    reason: "image is in use",
  });
  const url = new URL(engine.httpRequests[1]?.path ?? "", "http://fake-engine");
  expect(url.searchParams.get("all")).toBe("true");
  expect(JSON.parse(url.searchParams.get("filters") ?? "{}")).toEqual({
    ancestor: [target.replace(/^sha256:/u, "")],
  });
});

test("in-use explanations are redacted", async () => {
  const engine = new FakeEngine();
  engine.fail("image.delete", {
    status: 409,
    body: '{"message":"https://user:private-password@example.test is in use"}',
  });
  const result = await Effect.runPromise(remove(engine));
  expect(result).toMatchObject({
    kind: "in-use",
    reason: expect.stringContaining("example.test is in use"),
  });
  expect(JSON.stringify(result)).not.toContain("private-password");
});

test("container lookup errors fail rather than reporting incomplete in-use evidence", async () => {
  const engine = new FakeEngine();
  engine.fail("image.delete", { status: 409, body: '{"message":"in use"}' });
  engine.fail("container.list", { status: 500, body: '{"message":"lookup failed"}' });
  expect(await Effect.runPromise(Effect.result(remove(engine)))).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ProviderInternalError", operation: "removeArtifact" },
  });
});
