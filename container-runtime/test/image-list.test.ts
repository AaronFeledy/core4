import { expect, test } from "bun:test";
import { mapFailures } from "@lando/sdk/command-result";
import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import { Effect } from "effect";
import { listContainerArtifacts, normalizeImageRef } from "../src/image-list.ts";
import { FakeEngine } from "./support/fake-engine.ts";

const ctx = { providerId: "podman", remediation: "Start the runtime and retry.", env: {} };
const list = (engine: FakeEngine, labels: Readonly<Record<string, string>> = {}) =>
  listContainerArtifacts(
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
    { labels },
    ctx,
  );

test.each([
  ["docker.io/library/lando-build-a:latest", "lando-build-a"],
  ["localhost/lando-build-a:latest", "lando-build-a"],
  ["example.test/team/image:v2", "example.test/team/image:v2"],
  ["docker.io/library/php:8.3", "php:8.3"],
])("normalizes runtime ref %s to requested tag %s", (ref, expected) => {
  expect(normalizeImageRef(ref)).toBe(expected);
});

test("listing matches every label and preserves runtime IDs and normalized names", async () => {
  const engine = new FakeEngine();
  engine.assets.images.set("built", {
    Id: "sha256:built",
    Size: 1,
    Config: { Labels: { store: "a", owner: "web" } },
    RepoTags: ["docker.io/library/built:latest", "localhost/alias:latest", "example/image:v2"],
  });
  engine.assets.images.set("leaf", {
    Id: "sha256:leaf",
    Size: 1,
    Config: { Labels: { store: "a", owner: "web" } },
    RepoTags: ["<none>:<none>"],
  });
  engine.assets.images.set("other", {
    Id: "sha256:other",
    Size: 1,
    Config: { Labels: { store: "a", owner: "other" } },
  });
  expect(await Effect.runPromise(list(engine, { store: "a", owner: "web" }))).toEqual([
    { id: "sha256:built", refs: ["built", "alias", "example/image:v2"] },
    { id: "sha256:leaf", refs: [] },
  ]);
  const url = new URL(engine.httpRequests[0]?.path ?? "", "http://fake-engine");
  expect(url.pathname).toBe("/images/json");
  expect(url.searchParams.has("all")).toBe(false);
  expect(JSON.parse(url.searchParams.get("filters") ?? "{}")).toEqual({ label: ["store=a", "owner=web"] });
});

test("an unknown label returns an empty listing", async () => {
  const engine = new FakeEngine();
  engine.assets.images.set("other", {
    Id: "sha256:other",
    Size: 1,
    Config: { Labels: { store: "a" } },
  });
  expect(await Effect.runPromise(list(engine, { unknown: "label" }))).toEqual([]);
});

test("listing handles null and absent runtime tags as unnamed images", async () => {
  const engine = new FakeEngine();
  engine.fail("image.list", { status: 200, body: '[{"Id":"raw-id","RepoTags":null},{"Id":"other-id"}]' });
  expect(await Effect.runPromise(list(engine))).toEqual([
    { id: "raw-id", refs: [] },
    { id: "other-id", refs: [] },
  ]);
});

test("listing an unreachable runtime reports ProviderUnavailableError", async () => {
  const engine = new FakeEngine();
  engine.fail(
    "image.list",
    new ProviderUnavailableError({ ...ctx, operation: "request", message: "offline" }),
  );
  expect(await Effect.runPromise(Effect.result(list(engine)))).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ProviderUnavailableError", operation: "listArtifacts" },
  });
});

test("listing errors redact runtime details", async () => {
  const engine = new FakeEngine();
  engine.fail("image.list", {
    status: 500,
    body: '{"message":"https://user:private-password@example.test failed"}',
  });
  const result = await Effect.runPromise(Effect.result(list(engine)));
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
      _tag: "ProviderInternalError",
      operation: "listArtifacts",
      message: expect.stringContaining("example.test failed"),
    },
  });
  expect(JSON.stringify(result)).not.toContain("private-password");
});

test.each(["not JSON", '[{"Id":7}]'])("malformed listing %s is an internal error", async (body) => {
  const engine = new FakeEngine();
  engine.fail("image.list", { status: 200, body });
  expect(await Effect.runPromise(Effect.result(list(engine)))).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ProviderInternalError", operation: "listArtifacts" },
  });
});
