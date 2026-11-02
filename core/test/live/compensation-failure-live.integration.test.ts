import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serviceContainerName } from "@lando/container-runtime/plan";
import { makePodmanApiClient } from "@lando/container-runtime/podman/api-client";
import { makeLandoPaths } from "@lando/paths";
import { appCertificateFiles } from "@lando/proxy-traefik";
import { ProxyApplyError } from "@lando/sdk/errors";
import { runProbe } from "@lando/sdk/probe";
import {
  AppId,
  CommandResultEnvelope,
  InfoAppResult,
  type ServiceConnection,
  StartAppResult,
} from "@lando/sdk/schema";
import { Duration, Effect, Schema } from "effect";
import { decodeInfoCliEnvelope, runFixtureCli } from "./convergence-cli.ts";
import { liveEnabled, managedProviderSocketPath } from "./scanner-live-fixture";

// Uses the inherited managed runtime and global router, like the other CLI-driven live
// tests. The fault lives only at this app's own certificate path, so other apps are untouched.
const cliEntry = resolve(import.meta.dir, "../../bin/lando.ts");
const inventoryNotice = "Start did not complete. Resources were left in place";

// Decode the terminal frame, including the public envelope, strictly: human inventory
// belongs on stderr only, not in new machine-envelope fields or extra rollback errors.
const terminalEnvelope = (stdout: string) =>
  Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.TaggedStruct("result", { envelope: CommandResultEnvelope })),
    { onExcessProperty: "error" },
  )(stdout.trim().split("\n").at(-1)).envelope;

const containerObservation = Schema.Struct({
  Id: Schema.NonEmptyString,
  State: Schema.Struct({ Running: Schema.Boolean }),
});

const inspectContainer = async (container: string) => {
  // Use the provider's HTTP transport for Unix sockets and Windows named pipes alike.
  const api = makePodmanApiClient(managedProviderSocketPath, {
    env: { ...process.env },
    providerId: "lando",
    remediation: "Inspect the opted-in managed provider socket.",
  });
  if (api.request === undefined) throw new Error("The managed provider has no HTTP request transport.");
  const response = await Effect.runPromise(
    api
      .request({ method: "GET", path: `/containers/${encodeURIComponent(container)}/json` })
      .pipe(Effect.timeout("10 seconds")),
  );
  return response;
};

const inspectWeb = async (container: string) => {
  const response = await inspectContainer(container);
  expect(response.status, response.body).toBe(200);
  return Schema.decodeUnknownSync(Schema.fromJsonString(containerObservation))(response.body);
};

const landoCommand = (cwd: string, args: readonly string[]) => {
  const binary = process.env.LANDO_SCENARIO_E2E_BINARY;
  // A compiled runner may be acting as Bun through BUN_BE_BUN; the CLI under test must not inherit it.
  const { BUN_BE_BUN: _bunBeBun, ...inherited } = process.env;
  return runFixtureCli([...(binary === undefined ? [process.execPath, cliEntry] : [binary]), ...args], cwd, {
    ...(binary === undefined ? process.env : inherited),
    LANDO_TELEMETRY_ENABLED: "false",
  });
};

const lando = (cwd: string, args: readonly string[]) => Effect.runPromise(landoCommand(cwd, args));

const isHttpsRoute = (connection: ServiceConnection, hostname: string) =>
  connection.scope === "host" &&
  connection.source === "route" &&
  connection.protocol === "https" &&
  connection.binding === "assigned" &&
  new URL(connection.url).protocol === "https:" &&
  new URL(connection.url).hostname === hostname;

const waitForActiveRoute = async (cwd: string, hostname: string) => {
  let connections: ReadonlyArray<ServiceConnection> = [];
  const observed = await Effect.runPromise(
    runProbe(
      {
        id: `${hostname}-observed-route`,
        policy: { maxAttempts: 30, delay: Duration.millis(100), timeout: Duration.seconds(30) },
        classify: {
          success: (active) => (active ? "green" : "red"),
          failure: (cause) => {
            throw cause;
          },
        },
      },
      Effect.gen(function* () {
        const info = yield* landoCommand(cwd, ["info", "--format=json"]);
        return yield* Effect.try({
          try: () => {
            expect(info.exitCode, info.stdout + info.stderr).toBe(0);
            const envelope = decodeInfoCliEnvelope(info.stdout);
            expect(envelope.ok).toBe(true);
            const result = Schema.decodeUnknownSync(InfoAppResult)(envelope.result);
            connections = result.services.find((service) => service.service === "web")?.connections ?? [];
            return connections.some(
              (connection) => isHttpsRoute(connection, hostname) && connection.state === "active",
            );
          },
          catch: (cause) => cause,
        });
      }),
    ),
  );
  expect(observed.outcome, JSON.stringify(observed)).toBe("green");
  return connections;
};

test.skipIf(!liveEnabled)(
  "start preserves the running container and converges when an app-owned route apply fault is removed",
  async () => {
    // Given: a working routed nginx app. The #1462 fault blocks certificate refresh
    // and would also block the old destructive rollback; no global file is modified.
    const appRoot = await mkdtemp(join(tmpdir(), "lando-convergence-live-"));
    const name = `convergence-${crypto.randomUUID().slice(0, 8)}`;
    const marker = `recovered-route-${crypto.randomUUID()}`;
    // This short lowercase/hyphen name is already a normalized planner slug.
    const container = serviceContainerName({ slug: name }, "web");
    const initialHostname = `${name}.lndo.site`;
    const newHostname = `second-${name}.lndo.site`;
    const certificate = appCertificateFiles(makeLandoPaths(), AppId.make(name)).cert;
    const pinned = join(certificate, "pinned");
    const landofile = (hostnames: readonly string[]) =>
      `name: ${name}\nprovider: lando\nservices:\n  web:\n    type: nginx\n    webroot: .\n    routes:\n${hostnames.map((hostname) => `      - hostname: ${hostname}\n        scheme: both\n`).join("")}`;
    let faulted = false;
    let pinnedCreated = false;
    const removeFault = async () => {
      if (!faulted) return;
      if (pinnedCreated) await chmod(pinned, 0o700);
      await rm(certificate, { recursive: true, force: true });
      faulted = false;
    };
    try {
      // mkdtemp creates 0700; nginx reads the bind-mounted webroot as an unprivileged user.
      await chmod(appRoot, 0o755);
      await Bun.write(join(appRoot, "index.html"), marker);
      await Bun.write(join(appRoot, ".lando.yml"), landofile([initialHostname]));
      const started = await lando(appRoot, ["start", "--format=json"]);
      expect(started.exitCode, started.stdout + started.stderr).toBe(0);
      const initial = await inspectWeb(container);
      expect(initial.State.Running).toBe(true);
      const initialResult = Schema.decodeUnknownSync(StartAppResult)(terminalEnvelope(started.stdout).result);
      expect(
        initialResult.servicesStarted
          .find((service) => service.name === "web")
          ?.connections.some((connection) => isHttpsRoute(connection, initialHostname)),
      ).toBe(true);
      // File-provider reload is asynchronous. Prove live evidence before injecting the fault.
      await waitForActiveRoute(appRoot, initialHostname);
      await rm(certificate, { force: true });
      await mkdir(certificate);
      faulted = true;
      await mkdir(pinned);
      pinnedCreated = true;
      await writeFile(join(pinned, "file"), "pinned");
      await chmod(join(pinned, "file"), 0o400);
      await chmod(pinned, 0o500);
      await Bun.write(join(appRoot, ".lando.yml"), landofile([initialHostname, newHostname]));

      // When: start reconciles the new route against the still-running app.
      const text = await lando(appRoot, ["start", "--renderer=plain"]);

      // Then (human surface): one final warning inventories the retained web container
      // after the tagged primary error, with recovery/shutdown guidance and no rollback.
      expect(text.exitCode, text.stdout + text.stderr).toBe(1);
      expect(await inspectWeb(container)).toEqual(initial);
      expect(text.stderr).toContain("code: ProxyApplyError");
      expect(text.stdout + text.stderr).not.toContain("Rollback also failed");
      expect((text.stdout + text.stderr).split(inventoryNotice)).toHaveLength(2);
      const trailingWarning = text.stderr.trimEnd().split("\n").at(-1) ?? "";
      expect(trailingWarning).toContain(inventoryNotice);
      expect(trailingWarning).toMatch(/Running: web; created\/stopped: none; unverified: none/u);
      expect(text.stderr.indexOf(inventoryNotice)).toBeGreaterThan(
        text.stderr.indexOf("code: ProxyApplyError"),
      );
      expect(trailingWarning).toContain("Agent forwarding/file sync remain active");
      for (const command of [
        "lando info",
        "lando logs",
        "lando start",
        "lando stop",
        "lando destroy",
        "--volumes",
      ]) {
        expect(trailingWarning).toContain(command);
      }

      // Machine surface: retry the same fault; the terminal result keeps the existing
      // envelope contract, without human inventory on either stream or rollback errors.
      const json = await lando(appRoot, ["start", "--format=json"]);
      expect(json.exitCode, json.stdout + json.stderr).toBe(1);
      const failure = terminalEnvelope(json.stdout);
      expect(failure).toMatchObject({
        apiVersion: "v4",
        ok: false,
        error: { _tag: "ProxyApplyError" },
      });
      Schema.decodeUnknownSync(ProxyApplyError, { onExcessProperty: "error" })(failure.error);
      expect(failure.error?.additionalErrors).toBeUndefined();
      expect(json.stdout + json.stderr).not.toContain(inventoryNotice);
      expect(json.stdout + json.stderr).not.toContain("Running: web");
      expect(json.stdout + json.stderr).not.toContain("Rollback also failed");
      expect(await inspectWeb(container)).toEqual(initial);

      // Recovery surface: removing only our fault lets start finish the desired route
      // without recreating web. Verify the advertised endpoint actually serves this app.
      await removeFault();
      const recovered = await lando(appRoot, ["start", "--format=json"]);
      expect(recovered.exitCode, recovered.stdout + recovered.stderr).toBe(0);
      const envelope = terminalEnvelope(recovered.stdout);
      expect(envelope.ok).toBe(true);
      const result = Schema.decodeUnknownSync(StartAppResult)(envelope.result);
      expect(
        result.servicesStarted
          .find((service) => service.name === "web")
          ?.connections.some((connection) => isHttpsRoute(connection, newHostname)),
      ).toBe(true);
      const recoveredConnections = await waitForActiveRoute(appRoot, newHostname);
      expect(await inspectWeb(container)).toEqual(initial);
      const httpEndpoint = recoveredConnections
        .flatMap((connection) =>
          connection.scope === "host" && connection.binding === "assigned" && connection.state === "active"
            ? [new URL(connection.url)]
            : [],
        )
        .find((url) => url.protocol === "http:" && url.hostname === newHostname);
      if (httpEndpoint === undefined) throw new Error("Recovered web service has no new-host HTTP endpoint");
      // Bun's fetch replaces a custom Host header, so request loopback with node:http and the
      // advertised authority; Traefik's file-provider reload is asynchronous after start completes.
      const routed = await Effect.runPromise(
        runProbe(
          {
            id: `${name}-recovered-route`,
            policy: { maxAttempts: 80, delay: Duration.millis(100), timeout: Duration.seconds(8) },
            classify: { success: (body) => (body === marker ? "green" : "red"), failure: () => "red" },
          },
          Effect.tryPromise(
            (signal) =>
              new Promise<string>((resolveBody, rejectBody) => {
                const request = httpGet(
                  {
                    host: "127.0.0.1",
                    port: Number(httpEndpoint.port || 80),
                    path: "/",
                    headers: { Host: httpEndpoint.host },
                    signal,
                  },
                  (response) => {
                    let body = "";
                    response.setEncoding("utf8");
                    response.on("data", (chunk: string) => {
                      body += chunk;
                    });
                    response.on("end", () => resolveBody(body));
                  },
                );
                request.on("error", rejectBody);
              }),
          ).pipe(Effect.timeout("1 second")),
        ),
      );
      expect(routed.outcome).toBe("green");
      const stopped = await lando(appRoot, ["stop", "--format=json"]);
      expect(stopped.exitCode, stopped.stdout + stopped.stderr).toBe(0);
      const destroyed = await lando(appRoot, ["destroy", "-y", "--volumes", "--format=json"]);
      expect(destroyed.exitCode, destroyed.stdout + destroyed.stderr).toBe(0);
      expect((await inspectContainer(container)).status).toBe(404);
    } finally {
      // Always attempt every cleanup stage, including when setup or an assertion fails.
      // The inherited global router/runtime stays up; destroy targets only this app.
      try {
        await removeFault();
      } finally {
        try {
          const destroyed = await lando(appRoot, ["destroy", "-y", "--volumes", "--format=json"]);
          expect(destroyed.exitCode, destroyed.stdout + destroyed.stderr).toBe(0);
        } finally {
          await rm(appRoot, { recursive: true, force: true });
        }
      }
    }
  },
  // Bounded CLI mutations, route observations, and teardown must finish before Bun's test timeout.
  900_000,
);
