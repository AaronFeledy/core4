import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { retireTempRoots } from "@lando/engine/testing/temp-root-retirement";
import { makePodmanApiClient } from "@lando/provider-podman";
import { DestroyAppResult } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";

const socket = resolveLiveProviderSocket();
const required = process.env.LANDO_GUIDE_E2E === "1";
const childTimeout = 240_000;
const cliEntry = resolve(import.meta.dir, "../../bin/lando.ts");
const compiled = resolve(import.meta.dir, "../../dist/lando");
const STORE_LABEL = "dev.lando.build-store";
const envelope = Schema.Struct({ ok: Schema.Literal(true), result: Schema.Unknown });
const outputSchema = Schema.fromJsonString(
  Schema.Union([envelope, Schema.Struct({ _tag: Schema.Literal("result"), envelope })]),
);
const imageList = Schema.Array(
  Schema.Struct({
    Id: Schema.String,
    RepoTags: Schema.NullOr(Schema.Array(Schema.String)),
    Labels: Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
  }),
);

const shortName = (tag: string): string =>
  tag.replace(/^(?:localhost|docker\.io\/library)\//u, "").replace(/:latest$/u, "");

test.skipIf(socket === undefined && !required)(
  "built images rotate, survive destroy for reuse, and leave with --purge-caches",
  async () => {
    if (socket === undefined) throw new Error("An answering LANDO_TEST_PODMAN_SOCKET is required.");
    const api = makePodmanApiClient(socket.socketPath);
    const request = api.request;
    if (request === undefined) throw new Error("The Podman API client has no request transport.");
    const listImages = async (filters: Record<string, readonly string[]>, all = false) => {
      const query = new URLSearchParams({
        filters: JSON.stringify(filters),
        ...(all ? { all: "true" } : {}),
      });
      const response = await Effect.runPromise(
        request({ method: "GET", path: `/images/json?${query}`, signal: AbortSignal.timeout(30_000) }),
      );
      expect(response.status, response.body).toBe(200);
      return Schema.decodeUnknownSync(imageList)(JSON.parse(response.body));
    };
    const directory = await mkdtemp(join(tmpdir(), "lando-built-image-live-"));
    const root = join(directory, "app");
    const dataRoot = join(directory, "data");
    const nonce = crypto.randomUUID().slice(0, 8);
    const name = `reclaim-${nonce}`;
    // A unique service name keeps this test's image names apart from every concurrent suite.
    const service = `web-${nonce}`;
    const binary = process.env.LANDO_SCENARIO_E2E_BINARY ?? Bun.which(compiled) ?? undefined;
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => key !== "BUN_BE_BUN" && !key.startsWith("LANDO_CONFIG__"),
        ),
      ),
      LANDO_USER_CONF_ROOT: join(directory, "config"),
      LANDO_USER_DATA_ROOT: dataRoot,
      LANDO_USER_CACHE_ROOT: join(directory, "cache"),
      LANDO_SYSTEM_PLUGIN_ROOT: join(directory, "system-plugins"),
      LANDO_PROVIDER: "podman",
      DOCKER_HOST: `unix://${socket.socketPath}`,
      LANDO_CONFIG__default_provider_id: "podman",
      LANDO_TELEMETRY_ENABLED: "false",
    };
    const command = binary === undefined ? ([process.execPath, cliEntry] as const) : ([binary] as const);
    const lando = async (args: readonly string[]) => {
      const proc = Bun.spawn([...command, ...args, "--format=json"], {
        cwd: root,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: childTimeout,
        killSignal: "SIGKILL",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    };
    const cli = async (args: readonly string[]) => {
      const result = await lando(args);
      expect(result.exitCode, JSON.stringify({ args, ...result })).toBe(0);
      const output = Schema.decodeUnknownSync(outputSchema)(result.stdout.trim().split("\n").at(-1) ?? "");
      return ("envelope" in output ? output.envelope : output).result;
    };
    const dockerfile = (version: string) =>
      Bun.write(
        join(root, "docker", "Dockerfile"),
        `FROM docker.io/library/alpine:3.20\nRUN echo ${version} > /version\n`,
      );
    let store: string | undefined;
    // Every image this data root built, by tag, plus untagged leftovers that carry its store label.
    const storeImages = async () => {
      if (store === undefined) {
        const pattern = new RegExp(`^lando-build-([0-9a-f]{8})-podman-${service}-`, "u");
        for (const image of await listImages({ label: [STORE_LABEL] })) {
          const match = (image.RepoTags ?? []).map(shortName).find((tag) => pattern.test(tag));
          if (match !== undefined) store = image.Labels?.[STORE_LABEL];
        }
      }
      if (store === undefined) return { tagged: [], untagged: [], all: [] };
      const listed = await listImages({ label: [`${STORE_LABEL}=${store}`] });
      const real = (image: (typeof listed)[number]) =>
        (image.RepoTags ?? []).filter((tag) => tag !== "<none>:<none>").map(shortName);
      return {
        tagged: listed.filter((image) => real(image).length > 0).flatMap(real),
        untagged: listed.filter((image) => real(image).length === 0).map((image) => image.Id),
        all: (await listImages({ label: [`${STORE_LABEL}=${store}`] }, true)).map((image) => image.Id),
      };
    };
    const transcripts = async () => {
      const owners = join(dataRoot, "builds", "owners");
      const found: string[] = [];
      for (const owner of await readdir(owners).catch(() => [])) {
        const dir = join(owners, owner, "artifact", service);
        for (const file of await readdir(dir).catch(() => [])) if (file.endsWith(".log")) found.push(file);
      }
      return found;
    };

    await mkdir(join(root, "docker"), { recursive: true });
    try {
      await Bun.write(
        join(root, ".lando.yml"),
        `name: ${name}
runtime: 4
provider: podman
router:
  enabled: false
services:
  ${service}:
    type: compose
    build:
      context: ./docker
    home: false
    appMount: false
    command:
      - sleep
      - infinity
`,
      );
      await dockerfile("v1");
      await cli(["start"]);
      const first = await storeImages();
      expect(store, "the first build labels its image with this data root's store").toBeDefined();
      expect(first.tagged).toHaveLength(1);

      await dockerfile("v2");
      await cli(["start"]);
      const second = await storeImages();
      expect(second.tagged).toHaveLength(2);
      expect(
        second.tagged.some((tag) => tag.endsWith("-base")),
        "builds create no -base tags",
      ).toBe(false);
      expect(second.untagged, "a rebuild leaves no dangling store image").toEqual([]);
      const current = second.tagged.find((tag) => !first.tagged.includes(tag));
      if (current === undefined)
        throw new Error(`The second build kept its first tag: ${second.tagged.join(", ")}`);

      const destroyed = Schema.decodeUnknownSync(DestroyAppResult)(await cli(["destroy", "--yes"]));
      expect(destroyed.builtImages).toEqual({ removed: 1, released: 1, inUse: [] });
      expect((await storeImages()).tagged, "destroy keeps only the newest image for reuse").toEqual([
        current,
      ]);

      await cli(["start"]);
      expect(await transcripts(), "a start after destroy reuses the kept image without building").toEqual([]);
      expect((await storeImages()).tagged).toEqual([current]);

      const purged = Schema.decodeUnknownSync(DestroyAppResult)(
        await cli(["destroy", "--yes", "--purge-caches"]),
      );
      expect(purged.builtImages).toEqual({ removed: 1, released: 0, inUse: [] });
      const after = await storeImages();
      expect(after.tagged).toEqual([]);
      expect(after.untagged).toEqual([]);
      expect(after.all, "removal also reclaims the image's parent layers").toEqual([]);
    } finally {
      const retirement = await retireTempRoots({ directory, env, endpoint: socket.socketPath, command });
      expect(
        [...retirement.retained, ...retirement.failed],
        JSON.stringify({ directory, endpoint: socket.socketPath, ...retirement }),
      ).toEqual([]);
    }
  },
  8 * childTimeout + 120_000,
);
