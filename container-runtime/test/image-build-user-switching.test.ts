import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContainerBuildHttpRequest } from "@lando/container-runtime/image-build";
import { AbsolutePath } from "@lando/sdk/schema";
import { Effect } from "effect";
import { recordingRequest, runBuild } from "./image-build-user-fixture.ts";

const baseTag = "lando-build-docker-web-privilege-key-base";
const scaffold = {
  id: "lando.boot",
  phase: "build",
  command: "mkdir -p /etc/lando /etc/lando/env.d /etc/lando/certs",
  user: "root",
} as const;
const artifact = { kind: "ref", ref: "debian:12" } as const;

describe("artifact build step user switching", () => {
  test("restores the final service user rather than ignoring the runtime user", async () => {
    // Given
    const capture = recordingRequest("app:staff");
    // When
    await Effect.runPromise(
      runBuild({
        artifact,
        user: "runtime-only",
        steps: [scaffold, { phase: "build", command: "compile-as-app" }],
        request: capture.request,
      }),
    );
    // Then
    const dockerfile = (await capture.dockerfiles())[1];
    expect(dockerfile).toBe(
      `FROM ${baseTag}\nUSER root\nRUN mkdir -p /etc/lando /etc/lando/env.d /etc/lando/certs\nUSER runtime-only\nRUN compile-as-app\n`,
    );
    expect(dockerfile?.match(/^USER .+$/gmu)?.at(-1)).toBe("USER runtime-only");
  });

  test.each([
    {
      inherited: "app:staff",
      users: ["root", undefined, "root"],
      expected: `FROM ${baseTag}\nUSER root\nRUN step-1\nUSER app:staff\nRUN step-2\nUSER root\nRUN step-3\nUSER app:staff\n`,
    },
    {
      inherited: "root:wheel",
      users: ["root", "node", undefined],
      expected: `FROM ${baseTag}\nUSER root\nRUN step-1\nUSER node\nRUN step-2\nUSER root:wheel\nRUN step-3\n`,
    },
    { inherited: "app:staff", users: ["app:staff"], expected: `FROM ${baseTag}\nRUN step-1\n` },
    {
      inherited: "1000:1000",
      users: ["root", "1000:1000"],
      expected: `FROM ${baseTag}\nUSER root\nRUN step-1\nUSER 1000:1000\nRUN step-2\n`,
    },
    {
      inherited: "app:staff",
      users: ["root", "root"],
      expected: `FROM ${baseTag}\nUSER root\nRUN step-1\nRUN step-2\nUSER app:staff\n`,
    },
  ])(
    "emits only exact identity changes for $inherited and $users",
    async ({ inherited, users, expected }) => {
      // Given
      const capture = recordingRequest(inherited);
      const steps = users.map((user, index) => ({
        phase: "build",
        command: `step-${index + 1}`,
        ...(user === undefined ? {} : { user }),
      }));
      // When
      await Effect.runPromise(runBuild({ artifact, steps, request: capture.request }));
      // Then
      expect(await capture.dockerfiles()).toEqual(["FROM debian:12\n", expected]);
    },
  );

  test.each([undefined, ""])("keeps the pre-change root scaffold bytes for Config.User %s", async (user) => {
    // Given
    const capture = recordingRequest(user);
    // When
    await Effect.runPromise(runBuild({ artifact, steps: [scaffold], request: capture.request }));
    // Then
    expect(await capture.dockerfiles()).toEqual([
      "FROM debian:12\n",
      `FROM ${baseTag}\nRUN mkdir -p /etc/lando /etc/lando/env.d /etc/lando/certs\n`,
    ]);
  });

  test("inspects a build artifact's intermediate parent before the derived build", async () => {
    // Given
    const context = await mkdtemp(join(tmpdir(), "lando-user-build-"));
    try {
      await writeFile(join(context, "Dockerfile"), "FROM debian:12\n");
      const capture = recordingRequest("1001:1002");
      // When
      await Effect.runPromise(
        runBuild({
          artifact: { kind: "build", context: AbsolutePath.make(context) },
          steps: [scaffold],
          request: capture.request,
        }),
      );
      // Then
      expect(capture.requests.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
        `POST /build?t=${baseTag}&dockerfile=Dockerfile`,
        `GET /images/${baseTag}/json`,
        `GET /images/${baseTag}/json`,
        "POST /build?t=lando-build-docker-web-privilege-key&dockerfile=Dockerfile",
        "GET /images/lando-build-docker-web-privilege-key/json",
      ]);
      expect((await capture.dockerfiles())[1]).toBe(
        `FROM ${baseTag}\nUSER root\nRUN mkdir -p /etc/lando /etc/lando/env.d /etc/lando/certs\nUSER 1001:1002\n`,
      );
    } finally {
      await rm(context, { recursive: true, force: true });
    }
  });

  test.each([undefined, ""])(
    "preserves exact ordinary-build bytes without inherited inspection for Config.User %s",
    async (user) => {
      // Given
      const capture = recordingRequest(user);
      // When
      await Effect.runPromise(
        runBuild({ artifact, steps: [{ phase: "build", command: "compile" }], request: capture.request }),
      );
      // Then: only the existing final-tag availability check, never a parent inspection.
      expect(capture.requests.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
        "POST /build?t=lando-build-docker-web-privilege-key&dockerfile=Dockerfile",
        "GET /images/lando-build-docker-web-privilege-key/json",
      ]);
      expect(await capture.dockerfiles()).toEqual(["FROM debian:12\nRUN compile\n"]);
    },
  );

  test.each(["root wheel", "root\\", "-root", "root;id", "", 42, null])(
    "rejects invalid planned step user %j before any build request",
    async (user) => {
      // Given
      const capture = recordingRequest("app:staff");
      // When
      const result = await Effect.runPromise(
        Effect.either(
          runBuild({
            artifact,
            steps: [{ phase: "build", command: "install", user }],
            request: capture.request,
          }),
        ),
      );
      // Then
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left._tag).toBe("ProviderInternalError");
        expect(result.left.operation).toBe("buildArtifact");
        expect(result.left.remediation).toBeDefined();
      }
      expect(capture.requests).toHaveLength(0);
    },
  );

  test.each(["root wheel", "root\\", "-root", "root;id"])(
    "rejects invalid final service user %s before any build request",
    async (user) => {
      // Given
      const capture = recordingRequest("app:staff");
      // When
      const result = await Effect.runPromise(
        Effect.either(runBuild({ artifact, user, steps: [scaffold], request: capture.request })),
      );
      // Then
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left._tag).toBe("ProviderInternalError");
        expect(result.left.operation).toBe("buildArtifact");
        expect(result.left.remediation).toBeDefined();
      }
      expect(capture.requests).toHaveLength(0);
    },
  );

  test("rejects inherited users containing Dockerfile control characters", async () => {
    // Given
    const capture = recordingRequest("app\nUSER root");
    // When
    const failure = await Effect.runPromise(
      Effect.flip(runBuild({ artifact, steps: [scaffold], request: capture.request })),
    );
    // Then
    expect(failure._tag).toBe("ProviderInternalError");
    expect(failure.message).toContain("control characters");
  });

  test("fails closed when inherited-user inspection is non-successful", async () => {
    // Given
    let baseInspectCount = 0;
    const request = (entry: ContainerBuildHttpRequest) => {
      if (entry.method === "POST") return Effect.succeed({ status: 200, body: "" });
      if (entry.path.includes("-base")) {
        baseInspectCount += 1;
        return Effect.succeed(
          baseInspectCount === 1 ? { status: 200, body: "{}" } : { status: 503, body: "unavailable" },
        );
      }
      return Effect.succeed({ status: 200, body: "{}" });
    };
    // When
    const failure = await Effect.runPromise(Effect.flip(runBuild({ artifact, steps: [scaffold], request })));
    // Then
    expect(failure._tag).toBe("ProviderUnavailableError");
    expect(failure.remediation).toBeDefined();
  });

  test.each(["not-json", "{}", '{"Config":{"User":42}}'])(
    "fails closed for malformed inherited-user inspection: %s",
    async (body) => {
      // Given
      const request = () => Effect.succeed({ status: 200, body });
      // When
      const failure = await Effect.runPromise(
        Effect.flip(runBuild({ artifact, steps: [scaffold], request })),
      );
      // Then
      expect(failure._tag).toBe("ProviderInternalError");
      expect(failure.remediation).toBeDefined();
    },
  );
});
