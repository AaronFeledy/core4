import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineHttpApi } from "@lando/container-runtime/engine-api";
import { LANDO_DATA_ROOT_LABEL } from "@lando/sdk/schema";
import { Effect } from "effect";
import { artifactBuildStoreKey } from "../src/services/build-artifact-name.ts";
import { retireTempRoots, tempPodmanRootEnv } from "../src/testing/temp-root-retirement.ts";

const endpoint = "/unused-fake.sock";
const success = {
  exitCode: 0,
  stderr: "",
  stdout: JSON.stringify({
    apiVersion: "v4",
    command: "meta:uninstall",
    ok: true,
    result: {},
    warnings: [],
    deprecations: [],
  }),
};

async function fixture<T>(
  run: (value: {
    readonly directory: string;
    readonly endpoint: string;
    readonly command: readonly [string];
    readonly env: ReturnType<typeof tempPodmanRootEnv>;
  }) => Promise<T>,
) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "temp-root-retirement-test-")));
  try {
    return await run({
      directory,
      endpoint,
      command: ["/fake/lando"],
      env: tempPodmanRootEnv(directory, endpoint),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const readOnlyEngine = (
  respond: (url: URL) => { readonly body: unknown; readonly status?: number },
): EngineHttpApi => ({
  request: ({ method, path }) =>
    Effect.sync(() => {
      expect(method).toBe("GET");
      const { body, status = 200 } = respond(new URL(path, "http://fake"));
      return { status, body: JSON.stringify(body) };
    }),
});

test("purge can remove the roots before verification; only verified retirement removes the parent", async () => {
  await fixture(async (input) => {
    const { directory, env } = input;
    const data = join(directory, "canonical-data");
    const cache = join(directory, "canonical-cache");
    await mkdir(data);
    await mkdir(cache);
    await symlink(data, env.LANDO_USER_DATA_ROOT, "junction");
    await symlink(cache, env.LANDO_USER_CACHE_ROOT, "junction");
    const store = await Effect.runPromise(artifactBuildStoreKey(cache));
    const checked: string[] = [];
    const result = await retireTempRoots(input, {
      runCli: async ({ cmd, args, env: childEnv, replaceEnv }) => {
        expect(cmd).toBe(input.command[0]);
        expect(args).toEqual(["uninstall", "--purge", "--yes", "--format=json"]);
        expect(replaceEnv).toBe(true);
        expect(childEnv?.LANDO_SHELL_PROFILE).toBe(join(directory, "shell-profile"));
        expect(childEnv?.LANDO_USER_DATA_ROOT).toBe(data);
        expect(childEnv?.LANDO_TEST_DOCKER_SOCKET).toBe(`unix://${endpoint}`);
        await Promise.all(
          [data, cache, env.LANDO_USER_DATA_ROOT, env.LANDO_USER_CACHE_ROOT].map((root) =>
            rm(root, { recursive: true, force: true }),
          ),
        );
        return success;
      },
      engineApi: readOnlyEngine((url) => {
        expect(existsSync(data)).toBe(false);
        expect(existsSync(cache)).toBe(false);
        expect(existsSync(directory)).toBe(true);
        checked.push(url.pathname);
        const label =
          url.pathname === "/images/json"
            ? `dev.lando.build-store=${store}`
            : `${LANDO_DATA_ROOT_LABEL}=${data}`;
        expect(url.searchParams.get("filters")).toBe(JSON.stringify({ label: [label] }));
        return { body: url.pathname === "/volumes" ? { Volumes: null } : [] };
      }),
    });
    expect(checked.sort()).toEqual(["/containers/json", "/images/json", "/networks", "/volumes"]);
    expect(result).toEqual({ removed: [directory], retained: [], failed: [] });
    expect(existsSync(directory)).toBe(false);
  });
});

test.each([
  { ...success, exitCode: 1, stdout: "Partial failure report: /fixture/uninstall-report.json" },
  { ...success, stdout: "not an uninstall result" },
])("reports an unsuccessful purge without verification or deleting remaining roots: %j", async (purge) => {
  await fixture(async (input) => {
    await mkdir(input.env.LANDO_USER_DATA_ROOT);
    const result = await retireTempRoots(input, {
      runCli: async () => purge,
      engineApi: readOnlyEngine(() => {
        throw new Error("Verification ran despite a failed purge");
      }),
    });
    expect(result.failed).toEqual([
      expect.objectContaining({
        target: "uninstall --purge",
        _tag: "TempRootRetirementError",
        reason: expect.stringContaining(purge.stdout),
      }),
    ]);
    expect(result.removed).toEqual([]);
    expect(existsSync(input.env.LANDO_USER_DATA_ROOT)).toBe(true);
  });
});

test("reports every labeled leftover after purge, without retaining a class-owned cache", async () => {
  await fixture(async (input) => {
    const Labels = { [LANDO_DATA_ROOT_LABEL]: input.env.LANDO_USER_DATA_ROOT };
    const responses = new Map<string, unknown>([
      ["/containers/json", [{ Id: "stopped-container", Labels }]],
      ["/networks", [{ Id: "test-network-id", Name: "test-network", Labels }]],
      ["/volumes", { Volumes: [{ Name: "owned-volume", Labels }, { Name: "class-cache" }] }],
      ["/images/json", [{ Id: "store-image" }]],
    ]);
    const result = await retireTempRoots(input, {
      runCli: async () => success,
      engineApi: readOnlyEngine((url) => ({ body: responses.get(url.pathname) })),
    });
    expect(result.failed).toEqual([]);
    expect(result.retained.map(({ target }) => target).sort()).toEqual([
      "owned-volume",
      "stopped-container",
      "store-image",
      "test-network-id",
    ]);
    expect(existsSync(input.directory)).toBe(true);
  });
});

test("keeps the directory if verification cannot read the endpoint", async () => {
  await fixture(async (input) => {
    const result = await retireTempRoots(input, {
      runCli: async () => success,
      engineApi: readOnlyEngine((url) =>
        url.pathname === "/volumes" ? { status: 503, body: {} } : { body: [] },
      ),
    });
    expect(result.failed).toEqual([expect.objectContaining({ target: "volume verification" })]);
    expect(existsSync(input.directory)).toBe(true);
  });
});

test.each([
  {
    name: "captures the last stdout line as the purge result",
    script: `printf 'progress\\n%s\\n' '${success.stdout}'; echo noise >&2`,
    expected: (directory: string) => ({ removed: [directory], retained: [], failed: [] }),
  },
  {
    name: "reports the exit status and stderr of a failed purge",
    script: "echo partial-failure >&2; exit 3",
    expected: () => ({
      removed: [],
      retained: [],
      failed: [expect.objectContaining({ target: "uninstall --purge", reason: "Exit 3. partial-failure" })],
    }),
  },
])("runs purge through the process runner without a CLI double: $name", async ({ script, expected }) => {
  await fixture(async (input) => {
    const result = await retireTempRoots(
      { ...input, command: ["/bin/sh", "-c", script, "purge"] },
      {
        engineApi: readOnlyEngine((url) => ({ body: url.pathname === "/volumes" ? { Volumes: null } : [] })),
      },
    );
    expect(result).toEqual(expected(input.directory));
  });
});

test.each(["LANDO_TEST_PODMAN_SOCKET", "DOCKER_HOST", "LANDO_TEST_DOCKER_SOCKET"])(
  "rejects mismatched %s before running purge or verification",
  async (key) => {
    await fixture(async (input) => {
      const result = await retireTempRoots(
        { ...input, env: { ...input.env, [key]: "/wrong.sock" } },
        {
          runCli: async () => {
            throw new Error("Purge must not run");
          },
          engineApi: readOnlyEngine(() => {
            throw new Error("Verification must not run");
          }),
        },
      );
      expect(result.failed).toEqual([
        expect.objectContaining({
          target: input.directory,
          reason: expect.stringContaining("endpoint does not match"),
        }),
      ]);
      expect(existsSync(input.directory)).toBe(true);
    });
  },
);
