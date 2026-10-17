import { expect, test } from "bun:test";
import { Effect } from "effect";

import { recordingRequest, runBuild } from "./image-build-user-fixture.ts";

test.each(["first\nsecond", "first\r\nsecond", "tab\there", "escape\u001b", "delete\u007f"])(
  "preserves JSON-encoded exec arguments containing %j",
  async (payload) => {
    // Given: an exec-form argument whose bytes are data, not Dockerfile syntax.
    const command = ["printf", "%s", `${payload}\nRUN echo injected\n# escape=\u0060`];
    const recorder = recordingRequest(undefined);

    // When: the provider renders a derived image build.
    await Effect.runPromise(
      runBuild({
        artifact: { kind: "ref", ref: "alpine:3.22" },
        steps: [{ id: "payload", phase: "build", command }],
        request: recorder.request,
      }),
    );

    // Then: one RUN instruction round-trips the exact argv, including newlines.
    const dockerfiles = await recorder.dockerfiles();
    expect(dockerfiles).toHaveLength(1);
    const instructions = dockerfiles[0]?.split("\n").filter((line) => line.startsWith("RUN ")) ?? [];
    expect(instructions).toHaveLength(1);
    expect(JSON.parse(instructions[0]?.slice(4) ?? "null")).toEqual(command);
  },
);

test.each(["printf ok\nRUN echo injected", "printf ok\r", "printf\tok", "printf \u0000"])(
  "rejects raw shell-form Dockerfile control characters in %j",
  async (command) => {
    // Given: shell-form text is inserted directly into the Dockerfile.
    const recorder = recordingRequest(undefined);

    // When: a raw control character reaches the build renderer.
    const failure = await Effect.runPromise(
      Effect.flip(
        runBuild({
          artifact: { kind: "ref", ref: "alpine:3.22" },
          steps: [{ id: "raw", phase: "build", command }],
          request: recorder.request,
        }),
      ),
    );

    // Then: the renderer rejects it before sending a build request.
    expect(failure._tag).toBe("ProviderInternalError");
    expect(recorder.requests).toHaveLength(0);
  },
);

test("rejects NUL in exec-form argv before sending a build", async () => {
  // Given: NUL cannot be represented inside an operating-system process argument.
  const recorder = recordingRequest(undefined);

  // When: an exec-form payload contains NUL.
  const failure = await Effect.runPromise(
    Effect.flip(
      runBuild({
        artifact: { kind: "ref", ref: "alpine:3.22" },
        steps: [{ id: "nul", phase: "build", command: ["printf", "%s", "a\u0000b"] }],
        request: recorder.request,
      }),
    ),
  );

  // Then: JSON escaping does not permit an unusable process argument through.
  expect(failure._tag).toBe("ProviderInternalError");
  expect(recorder.requests).toHaveLength(0);
});
