import { describe, expect, test } from "bun:test";
import { Result, Schema } from "effect";

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
    const result = Schema.decodeUnknownResult(PreparedFileSyncTarget)(valid);
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) {
      expect(result.success.session.mountKey).toBe("app-mount");
      expect(result.success.endpoint.containerId).toBe("verified-container-id");
    }
  });

  test("rejects empty identities and non-container endpoints", () => {
    for (const endpoint of [
      { ...valid.endpoint, containerId: "" },
      { ...valid.endpoint, volumeName: "" },
      { ...valid.endpoint, _tag: "service" },
      { ...valid.endpoint, path: "relative" },
    ]) {
      expect(Result.isFailure(Schema.decodeUnknownResult(PreparedFileSyncTarget)({ ...valid, endpoint }))).toBe(
        true,
      );
    }
  });
});
