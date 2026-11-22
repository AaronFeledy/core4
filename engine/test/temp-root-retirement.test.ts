import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineHttpApi } from "@lando/container-runtime/engine-api";
import { LANDO_DATA_ROOT_LABEL, landoSharedCrossAppNetworkName } from "@lando/sdk/schema";
import { Effect } from "effect";
import { type TempRootRetirement, retireTempRoots } from "../src/testing/temp-root-retirement.ts";

const label = "dev.lando.build-store";
const image = `sha256:${"a".repeat(64)}`;
const otherImage = `sha256:${"b".repeat(64)}`;
const json = (body: unknown, status = 200) => ({ status, body: JSON.stringify(body) });

async function fixture(run: (input: TempRootRetirement, store: string, dataRoot: string) => Promise<void>) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "temp-root-retirement-test-")));
  const cache = join(directory, "cache");
  const dataRoot = join(directory, "data");
  try {
    await run(
      {
        directory,
        endpoint: "/unused-fake.sock",
        command: ["/fake/lando"],
        env: {
          LANDO_USER_DATA_ROOT: dataRoot,
          LANDO_TEST_PODMAN_SOCKET: "/unused-fake.sock",
          LANDO_USER_CONF_ROOT: join(directory, "conf"),
          LANDO_USER_CACHE_ROOT: cache,
          LANDO_SYSTEM_PLUGIN_ROOT: join(directory, "system-plugins"),
        },
      },
      new Bun.CryptoHasher("sha256").update(cache).digest("hex").slice(0, 8),
      dataRoot,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const fakeEngine = (
  store: string,
  state: "owned" | "in-use" | "foreign" | "drift" | "relabelled" | "multi-tag",
  options: {
    readonly beforeList?: () => void;
    readonly dataRoot?: string;
    readonly sharedNetwork?: "owned" | "foreign" | "unlabeled" | "wrong-role" | "attached";
    readonly leftover?: "container" | "network" | "volume" | "image";
    readonly volumeListStatus?: number;
  } = {},
) => {
  const ownTag = `localhost/lando-build-${store}-podman-web-key:latest`;
  const images = new Set([image, otherImage]);
  const tags = new Set(
    state === "multi-tag" ? [ownTag, `localhost/lando-build-${store}-podman-web-older:latest`] : [ownTag],
  );
  const dataLabels = options.dataRoot === undefined ? {} : { [LANDO_DATA_ROOT_LABEL]: options.dataRoot };
  const networkName = landoSharedCrossAppNetworkName(options.dataRoot ?? "unused");
  const networkId = "shared-network-id";
  const network = {
    Name: networkName,
    Id: networkId,
    Labels: {
      ...(options.sharedNetwork === "unlabeled" ? {} : dataLabels),
      ...(options.sharedNetwork === "foreign" ? { [LANDO_DATA_ROOT_LABEL]: "/another/root" } : {}),
      "dev.lando.network-role": options.sharedNetwork === "wrong-role" ? "private" : "shared-cross-app",
    },
    Containers: options.sharedNetwork === "attached" ? { "endpoint-id": {} } : {},
  };
  let networkPresent = options.sharedNetwork !== undefined;
  const api: EngineHttpApi = {
    request: ({ method, path }) =>
      Effect.sync(() => {
        const url = new URL(path, "http://fake");
        if (method === "GET" && url.pathname === "/images/json") {
          options.beforeList?.();
          const selected =
            url.searchParams.get("filters") === JSON.stringify({ label: [`${label}=${store}`] });
          const listed = selected ? [...images].filter((id) => id === image) : [...images];
          return json(
            url.searchParams.get("all") === "true"
              ? listed.map((Id) => ({
                  Id,
                  RepoTags: state === "foreign" ? ["team/backup:latest"] : [ownTag],
                }))
              : [],
          );
        }
        const imagePath = `/images/${encodeURIComponent(image)}`;
        if (method === "GET" && url.pathname === `${imagePath}/json`) {
          return json({
            Id: image,
            RepoTags: state === "drift" || state === "foreign" ? [ownTag, "team/backup:latest"] : [...tags],
            Config: { Labels: { [label]: state === "relabelled" ? "other" : store } },
          });
        }
        const tagPath = [...tags].find((tag) => url.pathname === `/images/${encodeURIComponent(tag)}`);
        if (method === "DELETE" && (url.pathname === imagePath || tagPath !== undefined)) {
          expect(url.search).toBe("?noprune=true");
          if (state === "in-use") return json({ message: "used by container" }, 409);
          if (tagPath === undefined && tags.size > 1)
            return json({ message: "unable to delete image by ID with more than one tag" }, 500);
          if (tagPath === undefined) tags.clear();
          else tags.delete(tagPath);
          if (tags.size === 0 && options.leftover !== "image") images.delete(image);
          return json([]);
        }
        const filters = url.searchParams.get("filters");
        if (method === "GET" && url.pathname === "/containers/json" && filters?.includes('"ancestor"')) {
          return json([{ Names: ["/still-running"] }]);
        }
        if (method === "GET" && url.pathname.startsWith("/networks/"))
          return networkPresent && url.pathname === `/networks/${networkName}`
            ? json(network)
            : json(null, 404);
        if (method === "DELETE" && url.pathname === `/networks/${networkId}` && url.search === "") {
          networkPresent = false;
          return { status: 204, body: "" };
        }
        if (
          method === "GET" &&
          (options.dataRoot === undefined ||
            filters === JSON.stringify({ label: [`${LANDO_DATA_ROOT_LABEL}=${options.dataRoot}`] }))
        ) {
          if (url.pathname === "/containers/json" && url.searchParams.get("all") === "true") {
            return json(
              options.leftover === "container" ? [{ Id: "stopped-container", Labels: dataLabels }] : [],
            );
          }
          if (url.pathname === "/networks")
            return json([
              ...(networkPresent ? [network] : []),
              ...(options.leftover === "network" ? [{ Name: "private-bridge", Labels: dataLabels }] : []),
            ]);
          if (url.pathname === "/volumes") {
            return json(
              {
                Volumes: [
                  { Name: "class-owned-cache", Labels: { "dev.lando.volume-class": "cache" } },
                  ...(options.leftover === "volume" ? [{ Name: "owned-data", Labels: dataLabels }] : []),
                ],
              },
              options.volumeListStatus,
            );
          }
        }
        throw new Error(`Unexpected fake engine request: ${method} ${path}`);
      }),
  };
  return { api, images, hasSharedNetwork: () => networkPresent };
};

const cliSuccess = async ({ args }: { readonly args: readonly string[] }) => ({
  exitCode: 0,
  stderr: "",
  stdout: envelope(args[0], args[0] === "apps:list" ? { apps: [] } : []),
});
const envelope = (command: string | undefined, result: unknown) =>
  JSON.stringify({ apiVersion: "v4", command, ok: true, result, warnings: [], deprecations: [] });

test("purges apps and the global app before removing only this cache store's images and deleting roots", async () => {
  await fixture(async (input, store) => {
    const teardown = [
      ["apps:list", "--format=json", "--all"],
      ["apps:scratch:list", "--format=json"],
      ["apps:gc", "--format=json", "--provider", "podman", "--prune", "--purge", "--purge-caches", "--yes"],
      ["meta:global:destroy", "--format=json", "--provider", "podman", "--purge", "--yes"],
    ];
    const { api, images } = fakeEngine(store, "owned", { beforeList: () => expect(teardown).toEqual([]) });
    const result = await retireTempRoots(input, {
      imageApi: api,
      runCli: async (command) => {
        expect(command.args).toEqual(teardown.shift() ?? []);
        expect(command.cmd).toBe("/fake/lando");
        for (const [key, value] of Object.entries(input.env)) expect(command.env?.[key]).toBe(value);
        return cliSuccess(command);
      },
    });
    expect(result).toEqual({ removed: [image], retained: [], failed: [] });
    expect([...images]).toEqual([otherImage]);
    expect(existsSync(input.directory)).toBe(false);
  });
});

test("removes the owned, endpoint-free shared network and deletes clean roots", async () => {
  await fixture(async (input, store, dataRoot) => {
    const { api, hasSharedNetwork } = fakeEngine(store, "owned", { dataRoot, sharedNetwork: "owned" });
    const result = await retireTempRoots(input, { imageApi: api, runCli: cliSuccess });
    expect(result).toEqual({
      removed: [image, landoSharedCrossAppNetworkName(dataRoot)],
      retained: [],
      failed: [],
    });
    expect(hasSharedNetwork()).toBe(false);
    expect(existsSync(input.directory)).toBe(false);
  });
});

test.each([
  ["foreign", "ownership"],
  ["unlabeled", "ownership"],
  ["wrong-role", "ownership"],
  ["attached", "endpoint-id"],
] as const)("leaves the %s shared network and directory intact", async (sharedNetwork, reason) => {
  await fixture(async (input, store, dataRoot) => {
    const { api, hasSharedNetwork } = fakeEngine(store, "owned", { dataRoot, sharedNetwork });
    const result = await retireTempRoots(input, { imageApi: api, runCli: cliSuccess });
    expect(result.failed).toEqual([]);
    expect(result.retained).toEqual([
      { target: landoSharedCrossAppNetworkName(dataRoot), reason: expect.stringContaining(reason) },
    ]);
    expect(hasSharedNetwork()).toBe(true);
    expect(existsSync(input.directory)).toBe(true);
  });
});

test.each([
  ["container", "stopped-container"],
  ["network", "private-bridge"],
  ["volume", "owned-data"],
  ["image", image],
] as const)("keeps the roots when final verification finds an owned %s", async (leftover, target) => {
  await fixture(async (input, store, dataRoot) => {
    const { api } = fakeEngine(store, "owned", { dataRoot, leftover });
    const result = await retireTempRoots(input, { imageApi: api, runCli: cliSuccess });
    expect(result.failed).toEqual([]);
    expect(result.retained).toEqual([{ target, reason: `Owned ${leftover} remains after retirement.` }]);
    expect(existsSync(input.directory)).toBe(true);
  });
});

test("keeps the roots when the endpoint cannot verify volumes", async () => {
  await fixture(async (input, store, dataRoot) => {
    const { api } = fakeEngine(store, "owned", { dataRoot, volumeListStatus: 500 });
    const result = await retireTempRoots(input, { imageApi: api, runCli: cliSuccess });
    expect(result.failed).toMatchObject([
      { target: "volume verification", reason: expect.stringContaining("HTTP 500") },
    ]);
    expect(existsSync(input.directory)).toBe(true);
  });
});

test.each([
  ["in-use", "still-running"],
  ["foreign", "team/backup:latest"],
  ["drift", "team/backup:latest"],
  ["relabelled", "build-store label"],
] as const)("retains the image and its roots when the image is %s", async (state, reason) => {
  await fixture(async (input, store) => {
    const { api, images } = fakeEngine(store, state);
    const result = await retireTempRoots(input, { imageApi: api, runCli: cliSuccess });
    expect(result.removed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.retained).toEqual([{ target: image, reason: expect.stringContaining(reason) }]);
    expect([...images]).toEqual([image, otherImage]);
    expect(existsSync(input.directory)).toBe(true);
  });
});

test("reports a CLI failure and keeps the roots even if the image is removed", async () => {
  await fixture(async (input, store) => {
    const { api } = fakeEngine(store, "owned");
    const result = await retireTempRoots(input, {
      imageApi: api,
      runCli: async ({ args }) =>
        args[0] === "apps:gc" ? { exitCode: 3, stdout: "", stderr: "purge failed" } : cliSuccess({ args }),
    });
    expect(result).toMatchObject({
      removed: [image],
      retained: [],
      failed: [
        {
          target: "apps:gc",
          reason: "Exit 3: purge failed",
          _tag: "TempRootRetirementError",
          remediation: expect.any(String),
        },
      ],
    });
    expect(existsSync(input.directory)).toBe(true);
  });
});

test("rejects a mismatched endpoint before starting CLI or HTTP work", async () => {
  await fixture(async (input) => {
    const unexpected = () => {
      throw new Error("mismatched descriptor reached I/O");
    };
    const result = await retireTempRoots(
      { ...input, endpoint: "/other.sock" },
      {
        runCli: unexpected,
        imageApi: { request: unexpected },
      },
    );
    expect(result.failed).toMatchObject([
      { _tag: "TempRootRetirementError", reason: expect.stringContaining("endpoint does not match") },
    ]);
    expect(existsSync(input.directory)).toBe(true);
  });
});

test("destroys only the verified app whose project still exists, before garbage collection", async () => {
  await fixture(async (input, store, dataRoot) => {
    const appRoot = join(input.directory, "project");
    const foreignRoot = join(input.directory, "foreign");
    await Promise.all([mkdir(appRoot), mkdir(foreignRoot)]);
    const fake = fakeEngine(store, "owned");
    let live = true;
    const api: EngineHttpApi = {
      request: (request) =>
        live && request.path.startsWith("/containers/json?")
          ? Effect.succeed(
              json([
                { Id: "owned", Labels: { [LANDO_DATA_ROOT_LABEL]: dataRoot, "dev.lando.app-root": appRoot } },
              ]),
            )
          : (fake.api.request?.(request) ?? Effect.die("fake has no transport")),
    };
    const result = await retireTempRoots(input, {
      imageApi: api,
      runCli: async ({ args, cwd }) => {
        if (args[0] === "apps:list")
          return {
            exitCode: 0,
            stderr: "",
            stdout: envelope("apps:list", {
              apps: [appRoot, foreignRoot].map((appRoot) => ({ appRoot, providerId: "podman" })),
            }),
          };
        if (args[0] === "app:destroy") {
          expect(args).toEqual([
            "app:destroy",
            "--format=json",
            "--provider",
            "podman",
            "--purge",
            "--purge-caches",
            "--yes",
          ]);
          expect(cwd).toBe(appRoot);
          live = false;
        }
        if (args[0] === "apps:gc") expect(live).toBe(false);
        return cliSuccess({ args });
      },
    });
    expect(result.failed).toEqual([]);
    expect(existsSync(input.directory)).toBe(false);
  });
});

test("removes an image tagged by several owned names one name at a time", async () => {
  await fixture(async (input, store) => {
    const { api, images } = fakeEngine(store, "multi-tag");
    const result = await retireTempRoots(input, { imageApi: api, runCli: cliSuccess });
    expect(result).toEqual({ removed: [image], retained: [], failed: [] });
    expect([...images]).toEqual([otherImage]);
    expect(existsSync(input.directory)).toBe(false);
  });
});
