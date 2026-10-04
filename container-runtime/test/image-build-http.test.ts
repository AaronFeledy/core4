import { expect, test } from "bun:test";
import { Effect } from "effect";
import { requestContainerBuild } from "../src/image-build-http.ts";

test("returns the first digest when build output mixes malformed lines and JSON frames", () => {
  // Given
  const request = () =>
    Effect.succeed({
      status: 200,
      body: 'invalid\n \n{"aux":{"Digest":"sha256:first"}}\n{"aux":{"Digest":"sha256:second"}}\n',
    });
  // When
  const digest = Effect.runSync(
    requestContainerBuild({
      request,
      options: { providerId: "docker", api: { request } },
      path: "/build",
      tag: "test-image",
      stdin: (async function* () {})(),
      secretValues: [],
    }),
  );
  // Then
  expect(digest).toBe("sha256:first");
});

test("returns the first build error when invalid lines precede multiple error frames", () => {
  // Given
  const request = () =>
    Effect.succeed({
      status: 200,
      body: 'invalid\n{"errorDetail":{"message":"first failure"}}\n{"error":"second failure"}\n',
    });
  // When
  const error = Effect.runSync(
    requestContainerBuild({
      request,
      options: { providerId: "docker", api: { request } },
      path: "/build",
      tag: "test-image",
      stdin: (async function* () {})(),
      secretValues: [],
    }).pipe(Effect.flip),
  );
  // Then
  expect(error).toMatchObject({
    _tag: "ArtifactBuildError",
    details: { message: "first failure", tag: "test-image" },
  });
});
