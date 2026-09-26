import { describe, expect, test } from "bun:test";
import { Either, Schema } from "effect";

import { PreparedFileSyncTarget } from "@lando/sdk/schema";

const valid = {
  session: {
    app: { kind: "user", id: "cms", root: "/projects/cms" },
    service: "web",
    mountKey: "app-mount",
    source: "/projects/cms",
    target: { _tag: "volume", name: "cms-web-app-mount", path: "/app" },
    mode: "two-way-safe",
    excludes: [".git"],
  },
  endpoint: {
    _tag: "container",
    containerId: "verified-container-id",
    path: "/sync",
    volumeName: "cms-web-app-mount",
  },
};

describe("PreparedFileSyncTarget", () => {
  test("decodes an exact container endpoint for a planned session", () => {
    const result = Schema.decodeUnknownEither(PreparedFileSyncTarget)(valid);
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right.session.mountKey).toBe("app-mount");
      expect(result.right.endpoint.containerId).toBe("verified-container-id");
    }
  });

  test("rejects empty identities and non-container endpoints", () => {
    for (const endpoint of [
      { ...valid.endpoint, containerId: "" },
      { ...valid.endpoint, volumeName: "" },
      { ...valid.endpoint, _tag: "service" },
      { ...valid.endpoint, path: "relative" },
    ]) {
      expect(Either.isLeft(Schema.decodeUnknownEither(PreparedFileSyncTarget)({ ...valid, endpoint }))).toBe(
        true,
      );
    }
  });
});
