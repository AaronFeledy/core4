import { expect, test } from "bun:test";
import type { Redactor } from "@lando/sdk/secrets";
import { DateTime, Effect } from "effect";
import { makeProviderDataPlane } from "../src/data-plane.ts";

const passthroughRedactor = {
  redactString: (value: string) => value,
  redactValue: (value: unknown) => value,
} satisfies Redactor;

test("maps labeled and legacy snapshot images and restricts the image query", async () => {
  const requests: string[] = [];
  const plane = makeProviderDataPlane({
    providerId: "lando",
    capabilities: { volumeSnapshot: "native" },
    redactor: passthroughRedactor,
    api: {
      request: (request) => {
        requests.push(request.path);
        return Effect.succeed({
          status: 200,
          body: JSON.stringify([
            {
              Id: "sha256:labeled",
              Size: 42,
              Created: 100,
              RepoTags: ["localhost/lando-volume-snapshot:sanitized"],
              Labels: { "dev.lando.snapshot-id": "Original-ID" },
            },
            {
              Id: "sha256:legacy",
              Size: 9,
              Created: 200,
              RepoTags: ["localhost/lando-volume-snapshot:old"],
              Labels: null,
            },
            { Id: "sha256:other", Size: 1, Created: 300, RepoTags: ["unrelated:image"] },
          ]),
        });
      },
    },
  });
  const images = await Effect.runPromise(plane.listVolumeSnapshots());
  expect(images.map((image) => ({ ...image, createdAt: DateTime.toEpochMillis(image.createdAt) }))).toEqual([
    {
      ref: {
        provider: "lando",
        id: "Original-ID",
        digest: "sha256:labeled",
        sizeBytes: 42,
        format: "native",
      },
      createdAt: 100000,
      labels: { "dev.lando.snapshot-id": "Original-ID" },
    },
    {
      ref: { provider: "lando", id: "old", digest: "sha256:legacy", sizeBytes: 9, format: "native" },
      createdAt: 200000,
      labels: {},
    },
  ]);
  expect(JSON.parse(new URL(`http://engine${requests[0]}`).searchParams.get("filters") ?? "null")).toEqual({
    reference: ["localhost/lando-volume-snapshot:*"],
  });
});

test("returns no snapshot artifacts for a non-native provider without HTTP", async () => {
  const plane = makeProviderDataPlane({
    providerId: "docker",
    capabilities: { volumeSnapshot: "none" },
    redactor: passthroughRedactor,
    api: { request: () => Effect.die("Non-native listing must not access the runtime") },
  });
  expect(await Effect.runPromise(plane.listVolumeSnapshots())).toEqual([]);
});
