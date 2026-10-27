import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { engineInfoArchitecture } from "@lando/container-runtime/capabilities";
import type { EngineHttpRequest } from "@lando/container-runtime/engine-api";
import { AppInfoResultSchema } from "@lando/engine/operations/info";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { makeLandoPaths } from "@lando/paths";
import { mvpProviderCapabilities } from "@lando/provider-lando";
import { makePodmanApiClient, podmanCapabilitiesForPlatform } from "@lando/provider-podman";
import { Effect, Schema } from "effect";
import { decodeInfoCliEnvelope } from "./convergence-cli.ts";
import { selectCatalogHomes } from "./home-persistence-fixture.ts";

const socket = resolveLiveProviderSocket();
const providerId = process.env.LANDO_CONFIG__default_provider_id ?? "podman";
const imageList = Schema.Array(
  Schema.Struct({
    Id: Schema.String,
    RepoTags: Schema.NullOr(Schema.Array(Schema.String)),
  }),
);
const volumeList = Schema.Struct({
  Volumes: Schema.NullOr(Schema.Array(Schema.Struct({ Name: Schema.String }))),
});

test.skipIf(socket === undefined)(
  "service users can write persisted homes across rebuild and user changes isolate stores",
  async () => {
    if (socket === undefined) throw new Error("A live Podman socket is required");
    expect(["lando", "podman"], "Configure a Lando or independent Podman fixture provider").toContain(
      providerId,
    );
    if (providerId === "lando")
      expect(socket.socketPath, "The opted-in socket must match the configured managed runtime").toBe(
        makeLandoPaths().providerSocketPath,
      );
    const api = makePodmanApiClient(socket.socketPath);
    const providerArch = engineInfoArchitecture(await Effect.runPromise(api.info)) ?? "unknown";
    const root = await mkdtemp(join(tmpdir(), "lando-home-persistence-live-"));
    const nonce = crypto.randomUUID().slice(0, 8);
    const name = `home-live-${nonce}`;
    // Unique service names also namespace derived image tags for exact, race-safe cleanup.
    const php = `php-${nonce}`;
    const node = `node-${nonce}`;
    const platform =
      process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";
    const capabilities =
      providerId === "lando"
        ? mvpProviderCapabilities(platform, process.arch)
        : podmanCapabilitiesForPlatform(platform);
    // Match the host facts and declared capabilities used by the production architecture guard.
    const selectedHomes = selectCatalogHomes(process.arch, capabilities, providerArch);
    if (selectedHomes.excluded.length > 0)
      console.info("HOME_PERSISTENCE_EXCLUDED", {
        arch: process.arch,
        providerArch,
        provider: providerId,
        types: selectedHomes.excluded.map(([type]) => type),
      });
    const catalogHomes = selectedHomes.supported.map(([type, user, target], index) => ({
      type,
      user,
      target,
      service: `catalog-${index}-${nonce}`,
    }));
    const persistedHomes = [
      { service: php, user: "www-data", target: "/var/www" },
      { service: node, user: "node", target: "/home/node" },
      ...catalogHomes,
    ];
    const request = api.request;
    if (request === undefined) throw new Error("Podman HTTP API is required");
    const call = (input: EngineHttpRequest) =>
      Effect.runPromise(
        request({
          ...input,
          signal: AbortSignal.timeout(30_000),
        }),
      );
    const images = async () => {
      const response = await call({ method: "GET", path: "/images/json" });
      expect(response.status, response.body).toBe(200);
      return Schema.decodeUnknownSync(imageList)(JSON.parse(response.body));
    };
    const beforeImages = new Set((await images()).map((image) => image.Id));
    const lando = async (args: readonly string[]) => {
      const binary = process.env.LANDO_SCENARIO_E2E_BINARY;
      const { BUN_BE_BUN: _bunBeBun, ...env } = process.env;
      const child = Bun.spawn(
        [
          ...(binary === undefined
            ? [process.execPath, resolve(import.meta.dirname, "../../bin/lando.ts")]
            : [binary]),
          ...args,
        ],
        {
          cwd: root,
          env: { ...env, LANDO_PROVIDER: providerId, LANDO_TELEMETRY_ENABLED: "false" },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          timeout: 600_000,
          killSignal: "SIGKILL",
        },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const result = { exitCode, stdout, stderr };
      expect(result.exitCode, `${args.join(" ")}\n${result.stdout}${result.stderr}`).toBe(0);
      return result;
    };
    const info = async () => {
      const result = await lando(["info", "--format=json"]);
      const envelope = decodeInfoCliEnvelope(result.stdout);
      expect(envelope.ok, result.stdout).toBe(true);
      return Schema.decodeUnknownSync(AppInfoResultSchema)(envelope.result);
    };
    const homeFor = async (service: string) => {
      const home = (await info()).services.find((row) => row.service === service)?.home;
      expect(home?.state, `${service}: info must report a persisted home`).toBe("persisted");
      if (home?.state !== "persisted") throw new Error(`${service}: missing persisted home`);
      expect(home.store.length).toBeGreaterThan(0);
      return home;
    };
    const volumeStatus = async (store: string) =>
      (await call({ method: "GET", path: `/volumes/${encodeURIComponent(store)}` })).status;
    const landofile = (nodeUser: "node" | "root") =>
      [
        `name: ${name}`,
        "runtime: 4",
        `provider: ${providerId}`,
        "router:",
        "  enabled: false",
        "services:",
        `  ${php}:`,
        "    type: php:8.3",
        "    via: fpm",
        "    user: www-data",
        "    composer: false",
        "    appMount: false",
        "    webroot: /app",
        `  ${node}:`,
        "    type: node:22",
        `    user: ${nodeUser}`,
        "    appMount: false",
        "    healthcheck:",
        "      kind: command",
        "      command: [node, --version]",
        ...catalogHomes.flatMap(({ type, service }) => [
          `  ${service}:`,
          `    type: ${type}`,
          "    appMount: false",
          "    certs: false",
          "    healthcheck: false",
          "    entrypoint: []",
          "    command: [sh, -c, 'trap \"exit 0\" TERM INT; while :; do sleep 1; done']",
          ...(type.startsWith("varnish") ? [`    backend: ${node}`] : []),
        ]),
        "",
      ].join("\n");
    const marker = `home-marker-${nonce}`;
    const stores = new Set<string>();
    try {
      // Keep catalog daemons idle so the fixture isolates image-user and fresh-volume behavior.
      await Bun.write(join(root, ".lando.yml"), landofile("node"));
      await lando(["start", "--format=json"]);
      for (const { service, user, target } of persistedHomes) {
        const home = await homeFor(service);
        stores.add(home.store);
        expect(home.target, service).toBe(target);
        expect(await volumeStatus(home.store), service).toBe(200);
        const written = await lando([
          "exec",
          service,
          "--",
          "sh",
          "-c",
          `test "$(id -un)" = '${user}' && test "$HOME" = '${target}' && test "$(stat -c %u "$HOME")" = "$(id -u)" && printf '%s' '${marker}' > "$HOME/.lando-home-live" && cat "$HOME/.lando-home-live"`,
        ]);
        expect(written.stdout.trim(), `${service}: home must be writable as ${user}`).toBe(marker);
      }
      const oldNode = await homeFor(node);

      // When the app is rebuilt, the mounted home files and store identities survive.
      await lando(["rebuild", "--yes", "--format=json"]);
      for (const { service } of persistedHomes) {
        const home = await homeFor(service);
        expect(stores.has(home.store), service).toBe(true);
        const retained = await lando(["exec", service, "--", "sh", "-c", 'cat "$HOME/.lando-home-live"']);
        expect(retained.stdout.trim(), service).toBe(marker);
      }

      // Then changing Node to root selects a new store without deleting the former user's home.
      await Bun.write(join(root, ".lando.yml"), landofile("root"));
      await lando(["start", "--format=json"]);
      const rootHome = await homeFor(node);
      stores.add(rootHome.store);
      expect(rootHome.target).toBe("/root");
      expect(rootHome.store).not.toBe(oldNode.store);
      expect(await volumeStatus(oldNode.store), "start must leave the old node home volume untouched").toBe(
        200,
      );
      const isolated = await lando([
        "exec",
        node,
        "--user",
        "root",
        "--",
        "sh",
        "-c",
        'test "$(id -u)" = 0 && test "$HOME" = /root && test ! -e "$HOME/.lando-home-live" && touch "$HOME/.lando-root-live"',
      ]);
      expect(isolated.exitCode).toBe(0);
      await lando(["destroy", "--yes", "--volumes", "--format=json"]);
      for (const store of stores) {
        expect(
          await volumeStatus(store),
          `destroy --volumes must remove ${store}, including the old user's store`,
        ).toBe(404);
      }
    } catch (error) {
      console.error("HOME_PERSISTENCE_FAILURE", { name, root, error });
      throw error;
    } finally {
      try {
        await lando(["destroy", "--yes", "--volumes", "--format=json"]);
      } finally {
        // A failed cleanup assertion must not leave this test's retained stores or build images behind.
        const filters = encodeURIComponent(JSON.stringify({ label: [`dev.lando.volume-owner=${root}`] }));
        const response = await call({ method: "GET", path: `/volumes?filters=${filters}` });
        expect(response.status, response.body).toBe(200);
        for (const volume of Schema.decodeUnknownSync(volumeList)(JSON.parse(response.body)).Volumes ?? []) {
          const removed = await call({
            method: "DELETE",
            path: `/volumes/${encodeURIComponent(volume.Name)}`,
          });
          expect([204, 404], removed.body).toContain(removed.status);
        }
        const afterImages = await images();
        const derivedTags = afterImages
          .flatMap((image) => image.RepoTags ?? [])
          .filter((tag) =>
            persistedHomes.some(({ service }) =>
              tag
                .replace(/^(localhost|docker.io\/library)\//u, "")
                .startsWith(`lando-build-${providerId}-${service}-`),
            ),
          )
          .sort((left, right) => Number(left.includes("-base:")) - Number(right.includes("-base:")));
        const pulledTags = afterImages
          .filter((image) => !beforeImages.has(image.Id))
          .flatMap((image) =>
            (image.RepoTags ?? []).filter((tag) =>
              [
                "docker.io/library/php:8.3-fpm-bookworm",
                "docker.io/library/node:22",
                "mcr.microsoft.com/mssql/server:2019-latest",
                "mcr.microsoft.com/mssql/server:2022-latest",
                "docker.io/library/solr:9",
                "docker.io/library/varnish:6",
                "docker.io/library/varnish:7",
              ].includes(tag),
            ),
          );
        for (const tag of [...derivedTags, ...pulledTags]) {
          const removed = await call({ method: "DELETE", path: `/images/${encodeURIComponent(tag)}` });
          expect([200, 204, 404], `image cleanup: ${removed.body}`).toContain(removed.status);
        }
        await rm(root, { recursive: true, force: true });
      }
    }
  },
  30 * 600_000,
);
