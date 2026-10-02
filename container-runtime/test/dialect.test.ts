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
      wait: libpodWaitDialect,
      sharedNetworkAttachment: "create-body",
      volumePrune: { enabled: true },
    });
    expect(dockerLifecycleDialect).toEqual({
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
      dockerPullDialect.inspect?.decodeDigest({
        RepoDigests: ["team/app@sha256:first", "team/app@sha256:second"],
      }),
    ).toBe("sha256:first");
    expect(dockerPullDialect.inspect?.decodeDigest({ RepoDigests: ["invalid"] })).toBeUndefined();
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
    expect(libpodPullDialect.inspect).toBeUndefined();
  });
});
