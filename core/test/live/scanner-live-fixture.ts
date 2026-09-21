import { watch } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Effect, Schema } from "effect";

import "@lando/core/bundled-plugins";
import { openLandoRuntime } from "@lando/core";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { makeLandoPaths } from "@lando/paths";

// openLandoRuntime's default bundled provider-lando always dials the managed
// runtime socket at PathsService.providerSocketPath; it never consults
// LANDO_TEST_PODMAN_SOCKET itself. Socket existence alone is unsafe: it would
// silently enable a live test against a user's real host runtime with no
// explicit opt-in. Eligibility therefore requires ALL of: an explicit
// nonempty LANDO_TEST_PODMAN_SOCKET, that override resolving (via the shared
// resolver) to a live socket, AND that live socket being exactly the managed
// path this fixture's runtime will dial. No env, or an env pointing anywhere
// else, must skip even when the managed socket happens to be live.
export const managedProviderSocketPath = makeLandoPaths().providerSocketPath;

export const isScannerLiveEligible = (): boolean => {
  const explicit = process.env.LANDO_TEST_PODMAN_SOCKET;
  if (explicit === undefined || explicit.length === 0) return false;
  const socket = resolveLiveProviderSocket();
  return socket !== undefined && socket.source === "env" && socket.socketPath === managedProviderSocketPath;
};

export const liveEnabled = isScannerLiveEligible();
const cliEntry = resolve(import.meta.dir, "../../bin/lando.ts");
const requestSchema = Schema.Struct({ host: Schema.String, path: Schema.String, method: Schema.String });

// This responder is a real container workload, not an injected scanner/HTTP fake.
// Successful and rejected scans both return endless bodies to exercise stream release.
const responder = `
const http = require('node:http');
const fs = require('node:fs');
http.createServer((req, res) => {
  if (req.url === '/independent') { res.end('published-responder'); return; }
  fs.writeFileSync('/proof/active.json', JSON.stringify({host:req.headers.host,path:req.url,method:req.method}));
  res.on('close', () => fs.writeFileSync('/proof/closed', 'closed'));
  if (req.url === '/hang') return;
  res.writeHead(req.url === '/fail' ? 503 : 200, {'content-type':'text/plain'});
  res.flushHeaders();
  res.write('unbounded-body');
}).listen(8080, '0.0.0.0');
`;

export const waitForFile = (root: string, name: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const arrived = Promise.withResolvers<void>();
      const watcher = watch(root, (_event, filename) => {
        if (filename === name) arrived.resolve();
      });
      return { watcher, arrived };
    }),
    ({ watcher }) => Effect.sync(() => watcher.close()),
  ).pipe(Effect.map(({ arrived }) => Effect.promise(() => arrived.promise)));

export const scannerFixture = (path: "/scan" | "/fail" | "/hang") =>
  Effect.gen(function* () {
    if (!isScannerLiveEligible()) {
      return yield* Effect.dieMessage(
        `LANDO_TEST_PODMAN_SOCKET must be explicitly set to the live managed runtime socket at ${managedProviderSocketPath}; this fixture requires openLandoRuntime's default provider socket, and socket existence alone is not a sufficient opt-in.`,
      );
    }
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "lando-scanner-live-"))),
      (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
    );
    const name = `scanner-${crypto.randomUUID().slice(0, 12)}`;
    const port = yield* Effect.acquireUseRelease(
      Effect.sync(() => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })),
      (reservation) => Effect.succeed(reservation.port),
      (reservation) => Effect.promise(() => reservation.stop(true)),
    );
    yield* Effect.promise(() =>
      Bun.write(
        join(root, ".lando.yml"),
        [
          `name: ${name}`,
          "runtime: 4",
          "provider: lando",
          "router:",
          "  enabled: false",
          "services:",
          "  web:",
          "    type: compose",
          "    image: docker.io/library/node:22-alpine",
          "    home: false",
          "    appMount: false",
          "    user: root",
          "    command:",
          "      - node",
          "      - -e",
          `      - ${JSON.stringify(responder)}`,
          "    volumes:",
          `      - ${root}:/proof`,
          "    endpoints:",
          "      - _tag: published",
          "        protocol: http",
          "        port: 8080",
          "        publication:",
          "          bindAddress: 127.0.0.1",
          `          hostPort: ${port}`,
          "    scanner:",
          `      path: ${path}`,
          "      retries: 2",
          "      timeout: 20000",
          "",
        ].join("\n"),
      ),
    );
    const runtime = yield* openLandoRuntime({ cwd: root, plugins: { policy: "bundled-only" } });
    const app = yield* runtime.app();
    yield* Effect.addFinalizer(() =>
      app.destroy({ volumes: true }).pipe(
        Effect.tap((receipt) =>
          Effect.sync(() => console.log("SCANNER_CLEANUP", JSON.stringify({ name, receipt }))),
        ),
        Effect.orDie,
      ),
    );
    return { root, name, app, runtime };
  });

export const recordedRequest = (root: string) =>
  Effect.promise(async () =>
    Schema.decodeUnknownSync(Schema.parseJson(requestSchema))(
      await readFile(join(root, "active.json"), "utf8"),
    ),
  );

export const startCli = (root: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const binary = process.env.LANDO_SCENARIO_E2E_BINARY;
      const proc = Bun.spawn(
        [...(binary === undefined ? [process.execPath, cliEntry] : [binary]), "start", "--format=json"],
        {
          cwd: root,
          env: { ...process.env, LANDO_TELEMETRY_ENABLED: "false" },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      return Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]).then(([exitCode, stdout, stderr]) => {
        console.log("SCANNER_CLI", exitCode, stdout, stderr);
        return { exitCode, stdout, stderr };
      });
    }),
    (completion) => Effect.promise(() => completion),
    (completion) => Effect.promise(() => completion).pipe(Effect.asVoid),
  );
