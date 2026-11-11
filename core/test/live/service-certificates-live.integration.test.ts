import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serviceContainerName } from "@lando/container-runtime/plan";
import { makePodmanApiClient } from "@lando/container-runtime/podman/api-client";
import { makeLandoPaths } from "@lando/paths";
import { certificatePairIsCurrent } from "@lando/sdk/certificates";
import { CommandResultEnvelope, appIdentityKey } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";

import { binary, decodeStart, infoEnvelope, prerequisite } from "./route-cli-live-support.ts";
import { managedProviderSocketPath } from "./scanner-live-fixture.ts";

// Uses the inherited managed runtime, router, and mkcert root; the job ran `lando setup` already.
const paths = makeLandoPaths();
const unselectableRouter = { LANDO_CONFIG__DEFAULT_ROUTER_SERVICE: "missing" };

const terminalEnvelope = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Union([Schema.TaggedStruct("result", { envelope: CommandResultEnvelope }), CommandResultEnvelope]),
  ),
);
const lastEnvelope = (stdout: string) => {
  const decoded = terminalEnvelope(stdout.trim().split("\n").at(-1) ?? "");
  return "envelope" in decoded ? decoded.envelope : decoded;
};

const containerObservation = Schema.fromJsonString(
  Schema.Struct({ Id: Schema.NonEmptyString, State: Schema.Struct({ Running: Schema.Boolean }) }),
);

const inspectContainer = async (container: string) => {
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
  expect(response.status, response.body).toBe(200);
  return Schema.decodeUnknownSync(containerObservation)(response.body);
};

const spawnText = async (
  cwd: string,
  argv: readonly string[],
  options: { readonly timeout?: number; readonly env?: Record<string, string> } = {},
) => {
  // Embedded Bun uses BUN_BE_BUN=1; compiled CLI children must dispatch Lando instead.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "BUN_BE_BUN"));
  const proc = Bun.spawn([...argv], {
    cwd,
    env: { ...env, LANDO_PROVIDER: "lando", LANDO_TELEMETRY_ENABLED: "false", ...options.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: options.timeout ?? 120_000,
    killSignal: "SIGKILL",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { argv, exitCode, stdout, stderr };
};

const lando = (cwd: string, args: readonly string[], options?: Parameters<typeof spawnText>[2]) =>
  spawnText(cwd, [binary, ...args], options);

const succeeded = (result: Awaited<ReturnType<typeof spawnText>>) => {
  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  return result.stdout;
};

const leafFiles = async (dir: string) => {
  const entries = await readdir(dir);
  const certs = entries.filter((entry) => entry.endsWith(".crt"));
  const keys = entries.filter((entry) => entry.endsWith(".key"));
  expect({ certs: certs.length, keys: keys.length, total: entries.length }).toEqual({
    certs: 1,
    keys: 1,
    total: 2,
  });
  const certPath = join(dir, certs[0] ?? "");
  const keyPath = join(dir, keys[0] ?? "");
  return { certPath, keyPath, cert: await readFile(certPath), key: await readFile(keyPath) };
};

describe.serial("generated service certificates and router-less teardown", () => {
  test.skipIf(prerequisite !== undefined && process.env.LANDO_GUIDE_E2E !== "1")(
    "issues once at apply, reuses unchanged material, and destroys without a selectable router",
    async () => {
      if (prerequisite !== undefined) throw new Error(prerequisite);
      // Given: setup already created the shared mkcert root and installed the managed binary.
      const mkcert = join(paths.binDir, process.platform === "win32" ? "mkcert.exe" : "mkcert");
      expect(existsSync(mkcert), mkcert).toBe(true);
      const caroot = succeeded(
        await spawnText(paths.binDir, [mkcert, "-CAROOT"], { timeout: 10_000 }),
      ).trim();
      const rootPem = await readFile(join(caroot, "rootCA.pem"), "utf8");
      expect(existsSync(join(paths.certsDir, "issued"))).toBe(false);

      const root = await realpath(await mkdtemp(join(tmpdir(), "lando-service-certs-live-")));
      const name = `certs-live-${crypto.randomUUID().slice(0, 8)}`;
      // This short lowercase/hyphen name is already a normalized planner slug.
      const container = serviceContainerName({ slug: name }, "web");
      const ownerKey = appIdentityKey("owner", root);
      const ownerCerts = join(paths.certsDir, "services", ownerKey);
      const routeFile = join(paths.globalAppRoot, "proxy-traefik", "dynamic", `routes-${ownerKey}.yml`);
      let destroyed = false;
      try {
        // mkdtemp creates 0700; nginx reads the bind-mounted app root as an unprivileged user.
        await chmod(root, 0o755);
        await Bun.write(join(root, "index.html"), name);
        await Bun.write(
          join(root, ".lando.yml"),
          [
            `name: ${name}`,
            "provider: lando",
            "services:",
            "  web:",
            "    type: nginx",
            "    certs: true",
            "",
          ].join("\n"),
        );

        // When: the first start issues the leaf at apply.
        const started = decodeStart(
          succeeded(await lando(root, ["start", "--format=json"], { timeout: 600_000 })),
        );
        const routeHosts = started.servicesStarted
          .find((service) => service.name === "web")
          ?.connections.flatMap((connection) =>
            connection.source === "route" && connection.host !== undefined ? [connection.host] : [],
          );
        expect(routeHosts?.length, JSON.stringify(started)).toBeGreaterThan(0);

        // Then: one current pair, signed by the mkcert root, covering the service's names.
        const first = await leafFiles(ownerCerts);
        if (process.platform !== "win32") expect((await stat(first.keyPath)).mode & 0o777).toBe(0o600);
        const names = ["web", `web.${name}.internal`, ...(routeHosts ?? []), "localhost", "127.0.0.1"];
        expect(
          certificatePairIsCurrent(
            { certificate: first.cert.toString("utf8"), privateKey: first.key.toString("utf8") },
            { names, now: Date.now(), root: rootPem },
          ),
          names.join(","),
        ).toBe(true);
        expect(existsSync(join(paths.certsDir, "issued"))).toBe(false);
        expect(existsSync(routeFile), routeFile).toBe(true);
        const running = await inspectContainer(container);
        expect(running.State.Running).toBe(true);

        // And: a second start reuses the material and keeps the container.
        succeeded(await lando(root, ["start", "--format=json"], { timeout: 300_000 }));
        const second = await leafFiles(ownerCerts);
        expect(second.certPath).toBe(first.certPath);
        expect(second.cert.equals(first.cert)).toBe(true);
        expect(second.key.equals(first.key)).toBe(true);
        expect(await inspectContainer(container)).toEqual(running);

        // And: the service sees the same PEM files through its environment.
        const inside = succeeded(
          await lando(root, [
            "exec",
            "web",
            "--",
            "sh",
            "-c",
            'test -n "$LANDO_SERVICE_CERT" && test -n "$LANDO_SERVICE_KEY" && test -r "$LANDO_SERVICE_CERT" && test -r "$LANDO_SERVICE_KEY" && cat "$LANDO_SERVICE_CERT" "$LANDO_SERVICE_KEY"',
          ]),
        );
        expect(inside).toContain(first.cert.toString("utf8").trim());
        expect(inside).toContain(first.key.toString("utf8").trim());

        // When: no router can be selected, a routed start fails fast and leaves the service alone.
        const refused = await lando(root, ["start", "--format=json"], { env: unselectableRouter });
        expect(refused.exitCode, JSON.stringify(refused)).toBe(1);
        expect(lastEnvelope(refused.stdout)).toMatchObject({
          ok: false,
          error: { _tag: "ProxySetupError", proxyId: "missing" },
        });
        expect(await inspectContainer(container)).toEqual(running);

        // Then: read and exec commands still work, and destroy withdraws routes and certificates.
        const info = Schema.decodeUnknownSync(infoEnvelope)(
          succeeded(await lando(root, ["info", "--format=json"], { env: unselectableRouter })),
        );
        expect(info.result.services.map((service) => service.service)).toContain("web");
        succeeded(await lando(root, ["exec", "web", "--", "true"], { env: unselectableRouter }));
        const teardown = await lando(root, ["destroy", "--yes", "--volumes", "--format=json"], {
          env: unselectableRouter,
          timeout: 180_000,
        });
        destroyed = teardown.exitCode === 0;
        succeeded(teardown);
        expect(teardown.stdout + teardown.stderr).not.toContain("not withdrawn");
        expect(existsSync(routeFile), routeFile).toBe(false);
        expect(existsSync(ownerCerts), ownerCerts).toBe(false);
      } finally {
        if (!destroyed) {
          const cleanup = await lando(root, ["destroy", "--yes", "--volumes", "--format=json"], {
            timeout: 180_000,
          });
          if (cleanup.exitCode !== 0) console.error("Cleanup destroy failed", JSON.stringify(cleanup));
        }
        await rm(root, { recursive: true, force: true });
      }
    },
    1_200_000,
  );
});
