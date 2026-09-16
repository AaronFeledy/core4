import { describe, expect, test } from "bun:test";

import {
  dockerPullDialect,
  dockerWaitDialect,
  libpodPullDialect,
  libpodWaitDialect,
  parseImageReference,
} from "../src/dialect.ts";

describe("container engine dialects", () => {
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
    expect(libpodPullDialect.frameError({ error: "denied" })).toBe("denied");
    expect(libpodPullDialect.frameError({ errorDetail: "ignored" })).toBeUndefined();
    expect(libpodPullDialect.inspect).toBeUndefined();
  });
});
