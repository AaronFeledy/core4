import { describe, expect, test } from "bun:test";

import {
  dockerLifecycleDialect,
  dockerPullDialect,
  dockerWaitDialect,
  libpodLifecycleDialect,
  libpodPullDialect,
  libpodWaitDialect,
  parseImagePlatform,
  parseImageReference,
} from "../src/dialect.ts";

describe("container engine dialects", () => {
  test("selects engine-specific lifecycle behavior", () => {
    // Given / When / Then
    expect(libpodLifecycleDialect).toEqual({
      engine: "libpod",
      wait: libpodWaitDialect,
      sharedNetworkAttachment: "create-body",
      volumePrune: { enabled: true },
    });
    expect(dockerLifecycleDialect).toEqual({
      engine: "docker",
      wait: dockerWaitDialect,
      sharedNetworkAttachment: "connect-after-create",
    });
  });

  test("parses os/arch and os/arch/variant image platform pins", () => {
    expect(parseImagePlatform("linux/amd64")).toEqual({ os: "linux", architecture: "amd64" });
    expect(parseImagePlatform("linux/arm64/v8")).toEqual({
      os: "linux",
      architecture: "arm64",
      variant: "v8",
    });
    expect(parseImagePlatform("amd64")).toBeUndefined();
  });

  test("rejects malformed platform pins instead of dropping empty or extra components", () => {
    // Given
    const pins = ["linux//amd64", "/linux/amd64", "linux/amd64/", "linux/arm/v7/extra"];

    // When
    const parsed = pins.map(parseImagePlatform);

    // Then
    expect(parsed).toEqual(pins.map(() => undefined));
  });

  test("parses tagged, untagged, registry-port, and digest image references", () => {
    // Given
    const references = ["nginx", "nginx:1.27", "registry:5000/team/app:v1", "team/app:v1@sha256:abc"];

    // When
    const parsed = references.map(parseImageReference);

    // Then
    expect(parsed).toEqual([
      { fromImage: "nginx", tag: "latest" },
      { fromImage: "nginx", tag: "1.27" },
      { fromImage: "registry:5000/team/app", tag: "v1" },
      { fromImage: "team/app", tag: "sha256:abc" },
    ]);
  });

  test("builds and decodes the Docker wait wire format", () => {
    // Given
    const signal = new AbortController().signal;

    // When
    const request = dockerWaitDialect.request("app/web", signal);
    const exitCode = dockerWaitDialect.decodeExitCode({ StatusCode: 17 });

    // Then
    expect(request).toEqual({ method: "POST", path: "/containers/app%2Fweb/wait", signal });
    expect(exitCode).toBe(17);
    expect(dockerWaitDialect.decodeExitCode({ StatusCode: "17" })).toBeUndefined();
  });

  test("builds and decodes the libpod wait wire format", () => {
    // Given / When
    const request = libpodWaitDialect.request("app/web");
    const exitCode = libpodWaitDialect.decodeExitCode(23);

    // Then
    expect(request).toEqual({ method: "POST", path: "/libpod/containers/app%2Fweb/wait" });
    expect(exitCode).toBe(23);
    expect(libpodWaitDialect.decodeExitCode({ StatusCode: 23 })).toBeUndefined();
  });

  test("builds Docker pull and inspect requests", () => {
    // Given
    const reference = "registry:5000/team/app:v1";

    // When
    const pull = dockerPullDialect.request(reference);
    const inspect = dockerPullDialect.inspect?.request(reference);

    // Then
    expect(pull).toEqual({
      method: "POST",
      path: "/images/create?fromImage=registry%3A5000%2Fteam%2Fapp&tag=v1",
    });
    expect(inspect).toEqual({ method: "GET", path: "/images/registry%3A5000%2Fteam%2Fapp%3Av1/json" });
    expect(dockerPullDialect.request(reference, { platform: "linux/amd64" })).toEqual({
      method: "POST",
      path: "/images/create?fromImage=registry%3A5000%2Fteam%2Fapp&tag=v1&platform=linux%2Famd64",
    });
  });

  test("decodes Docker pull errors and the first inspected digest", () => {
    // Given / When / Then
    expect(dockerPullDialect.frameError({ errorDetail: { message: "denied" } })).toBe("denied");
    expect(dockerPullDialect.frameError({ errorDetail: "blocked" })).toBe("blocked");
    expect(dockerPullDialect.frameError({ error: "failed" })).toBe("failed");
    expect(dockerPullDialect.frameError({ errorDetail: { message: 42 } })).toBeUndefined();
    expect(
      dockerPullDialect.inspect?.decodeDigest(
        {
          RepoDigests: ["team/app@sha256:first", "team/app@sha256:second"],
        },
        "team/app:latest",
      ),
    ).toBe("sha256:first");
    expect(dockerPullDialect.inspect?.decodeDigest({ RepoDigests: ["invalid"] }, "team/app")).toBeUndefined();
  });

  test("builds libpod pull requests and reads only string error fields", () => {
    // Given
    const reference = "team/app:v1";

    // When
    const request = libpodPullDialect.request(reference);

    // Then
    expect(request).toEqual({
      method: "POST",
      path: "/libpod/images/pull?reference=team%2Fapp%3Av1&pullProgress=true",
    });
    expect(libpodPullDialect.request(reference, { platform: "linux/amd64" })).toEqual({
      method: "POST",
      path: "/libpod/images/pull?reference=team%2Fapp%3Av1&pullProgress=true&OS=linux&Arch=amd64",
    });
    expect(libpodPullDialect.request(reference, { platform: "linux/arm64/v8" })).toEqual({
      method: "POST",
      path: "/libpod/images/pull?reference=team%2Fapp%3Av1&pullProgress=true&OS=linux&Arch=arm64&Variant=v8",
    });
    expect(libpodPullDialect.frameError({ error: "denied" })).toBe("denied");
    expect(libpodPullDialect.frameError({ errorDetail: "ignored" })).toBeUndefined();
    expect(libpodPullDialect.inspect?.request("team/app@sha256:pin")).toEqual({
      method: "GET",
      path: "/libpod/images/team%2Fapp%40sha256%3Apin/json",
    });
  });

  describe.each([dockerPullDialect, libpodPullDialect])("digest decoding", (dialect) => {
    test.each([
      {
        reference: "php:8.2-apache-bookworm",
        entries: ["other/app@sha256:wrong", "docker.io/library/php@sha256:right"],
        expected: "sha256:right",
      },
      {
        reference: "php",
        entries: ["myreg:5000/php@sha256:wrong", "docker.io/library/php@sha256:right"],
        expected: "sha256:right",
      },
      {
        reference: "team/app@sha256:second",
        entries: ["other/app@sha256:second", "team/app@sha256:first", "team/app@sha256:second"],
        expected: "sha256:second",
      },
      {
        reference: "team/app@sha256:second",
        entries: ["other/app@sha256:second", "team/app@sha256:first"],
        expected: "sha256:first",
      },
      { reference: "php", entries: ["other/php@sha256:wrong"], expected: undefined },
      { reference: "php", entries: ["php@bad", "php@sha256:", "php@sha256:right"], expected: "sha256:right" },
    ])("matches the requested repository and digest: %j", ({ reference, entries, expected }) => {
      expect(dialect.inspect?.decodeDigest({ RepoDigests: entries }, reference)).toBe(expected);
    });

    test("uses the registry Digest fallback without treating local ids as registry digests", () => {
      expect(dialect.inspect?.decodeDigest({ Id: "sha256:local-only" }, "php")).toBeUndefined();
      expect(
        dialect.inspect?.decodeDigest({ RepoDigests: [], Digest: "sha256:local-build" }, "php"),
      ).toBeUndefined();
      expect(
        dialect.inspect?.decodeDigest(
          { RepoDigests: ["other/app@sha256:other"], Digest: "sha256:pulled" },
          "php",
        ),
      ).toBe("sha256:pulled");
    });

    test.each([
      { reference: "team/app@sha256:second", expected: "sha256:second" },
      { reference: "team/app:latest", expected: "sha256:first" },
      { reference: "team/app@sha256:absent", expected: "sha256:first" },
    ])("selects a reported digest for $reference", ({ reference, expected }) => {
      // Given
      const json = {
        RepoDigests: [
          null,
          42,
          "invalid",
          "app@",
          "@sha256:bad",
          "app@bad",
          "app@sha256:",
          "team/app@sha256:first",
          "team/app@sha256:second",
        ],
      };
      // When
      const digest = dialect.inspect?.decodeDigest(json, reference);
      // Then
      expect(digest).toBe(expected);
    });

    test.each([
      null,
      {},
      { RepoDigests: [] },
      { RepoDigests: "app@sha256:pin" },
      { RepoDigests: [null, "app@", "invalid"] },
    ])("omits a digest when inspect has no valid entries: %j", (json) => {
      // Given / When
      const digest = dialect.inspect?.decodeDigest(json, "app@sha256:pin");
      // Then
      expect(digest).toBeUndefined();
    });
  });
});
