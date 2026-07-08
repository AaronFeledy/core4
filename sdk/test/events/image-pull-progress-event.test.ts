import { describe, expect, test } from "bun:test";

import { DateTime, Schema } from "effect";

import { ImagePullProgressEvent, LandoEvent } from "@lando/sdk/events";

const FIXED_TIMESTAMP = DateTime.unsafeMake("2026-07-08T03:30:00Z");
const timestamp = DateTime.formatIso(FIXED_TIMESTAMP);

describe("image-pull-progress event", () => {
  test("ImagePullProgressEvent decodes a redacted reference + progress payload", () => {
    const decoded = Schema.decodeUnknownSync(ImagePullProgressEvent)({
      _tag: "image-pull-progress",
      eventName: "image-pull-progress",
      reference: "docker.io/library/alpine:3.20.3",
      stream: "Pulling artifact",
      current: 1048576,
      total: 1234567,
      timestamp,
    });
    expect(decoded._tag).toBe("image-pull-progress");
    expect(decoded.reference).toBe("docker.io/library/alpine:3.20.3");
    expect(decoded.current).toBe(1048576);
    expect(decoded.total).toBe(1234567);
  });

  test("ImagePullProgressEvent accepts a minimal reference-only payload", () => {
    const decoded = Schema.decodeUnknownSync(ImagePullProgressEvent)({
      _tag: "image-pull-progress",
      eventName: "image-pull-progress",
      reference: "docker.io/library/alpine:3.20.3",
      timestamp,
    });
    expect(decoded._tag).toBe("image-pull-progress");
    expect(decoded.stream).toBeUndefined();
  });

  test("ImagePullProgressEvent is a member of the LandoEvent union", () => {
    const decoded = Schema.decodeUnknownSync(LandoEvent)({
      _tag: "image-pull-progress",
      eventName: "image-pull-progress",
      reference: "docker.io/library/alpine:3.20.3",
      timestamp,
    });
    expect(decoded._tag).toBe("image-pull-progress");
  });
});
