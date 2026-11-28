import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { release, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { ConfigLintResult } from "@lando/sdk/schema";
import { Schema } from "effect";

import { ensureCompiledCli } from "../_support/compiled-cli.ts";
import {
  binary,
  decodeStart,
  infoEnvelope,
  linuxProjectUserMapping,
  resolveRoutePodmanTarget,
  routeCli,
  routeCliPrerequisite,
  routeProviderEnv,
  run,
} from "./route-cli-live-support.ts";

const lintEnvelope = Schema.fromJsonString(
  Schema.Struct({ ok: Schema.Literal(true), result: ConfigLintResult }),
);
const strictProvider = Schema.decodeUnknownSync(Schema.UndefinedOr(Schema.Literals(["lando", "docker"])))(
  process.env.LANDO_TEST_NGINX_PRIVATE,
);
const docker = strictProvider === "docker";
const target = docker ? undefined : resolveRoutePodmanTarget(strictProvider === "lando");
const prerequisite = routeCliPrerequisite(target);
const systemDockerSocket = "/var/run/docker.sock";
const systemDockerHost = `unix://${systemDockerSocket}`;

const requireRootfulDocker = async () => {
  expect(Bun.which("curl"), "The private nginx check requires curl").not.toBeNull();
  expect(process.env.LANDO_TEST_DOCKER_SOCKET, "Opt in to the local system Docker Engine").toBe(
    systemDockerSocket,
  );
  const command = ["docker", "--host", systemDockerHost];
  const engine = await run(
    import.meta.dir,
    [...command, "version", "--format", "{{.Server.Platform.Name}}"],
    5_000,
  );
  expect(engine.trim()).toMatch(/^Docker Engine\b/u);
  const info = await run(
    import.meta.dir,
    [...command, "info", "--format", "{{.OSType}}\t{{.KernelVersion}}\t{{json .SecurityOptions}}"],
    5_000,
  );
  const [os, kernel, securityOptions] = info.trim().split("\t");
  expect(os).toBe("linux");
  expect(kernel, "The daemon must run on the same Linux host, not in a VM").toBe(release());
  const security = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))(
    securityOptions,
  );
  expect(security.some((option) => /^name=(rootless|userns)(,|$)/u.test(option))).toBe(false);
};

describe.serial("compiled CLI stock nginx", () => {
  test.skipIf(
    strictProvider === undefined && prerequisite !== undefined && process.env.LANDO_GUIDE_E2E !== "1",
  )(
    docker
      ? "serves private checkout files through a local Docker publication"
      : "serves HTML through global Traefik and keeps host files private when workers are mapped",
    async () => {
      const { uid, gid } = userInfo();
      if (strictProvider !== undefined) {
        expect(process.platform).toBe("linux");
        expect(uid, "Run the private nginx check as a non-root user").toBeGreaterThan(0);
        expect(gid, "Run the private nginx check with a non-root group").toBeGreaterThan(0);
      }
      if (!docker && (target === undefined || prerequisite !== undefined)) throw new Error(prerequisite);
      if (docker) await requireRootfulDocker();
      const provider = target?.provider ?? "docker";
      const mapping =
        target === undefined
          ? "image-renumber"
          : await linuxProjectUserMapping(target, strictProvider === "lando");
      const privateFiles = mapping !== "unsupported";
      if (strictProvider === "lando")
        expect(privateFiles, "The managed Linux socket must report a rootless engine").toBe(true);
      const cliBinary = docker ? await ensureCompiledCli() : binary;
      const appCli = routeCli(
        cliBinary,
        target === undefined
          ? { LANDO_PROVIDER: "docker", DOCKER_HOST: systemDockerHost }
          : routeProviderEnv(target),
      );
      // Given: a uniquely named app outside the repository and, for route coverage, an installed router.
      const root = await mkdtemp(join(tmpdir(), "lando-nginx-route-cli-"));
      const name = `route-cli-${crypto.randomUUID()}`;
      const hostname = `${name}.lndo.site`;
      const body = `nginx-route-proof-${crypto.randomUUID()}`;
      try {
        const expectRouterProvider = async () => {
          const global = Schema.decodeUnknownSync(infoEnvelope)(await appCli(root, ["global:info"])).result;
          expect(global.services.find((service) => service.service === "traefik")?.provider).toBe(provider);
        };
        if (provider === "lando") await expectRouterProvider();
        const publicRoot = join(root, "public");
        const index = join(publicRoot, "index.html");
        if (process.platform !== "win32") await chmod(root, privateFiles ? 0o700 : 0o755);
        await mkdir(publicRoot, { mode: privateFiles ? 0o700 : 0o755 });
        await Bun.write(index, body);
        if (process.platform !== "win32") await chmod(index, privateFiles ? 0o600 : 0o644);
        const permissions = () =>
          Promise.all(
            [root, publicRoot, index].map(async (path) => {
              const { uid, gid, mode } = await stat(path);
              return { uid, gid, mode: mode & 0o7777 };
            }),
          );
        const before = privateFiles ? await permissions() : undefined;
        if (before !== undefined) {
          expect(before.map(({ mode }) => mode)).toEqual([0o700, 0o700, 0o600]);
          expect(before.map((entry) => entry.uid)).toEqual([uid, uid, uid]);
        }
        await Bun.write(
          join(root, ".lando.yml"),
          [
            `name: ${name}`,
            "runtime: 4",
            `provider: ${provider}`,
            ...(docker ? ["router:", "  enabled: false"] : []),
            "services:",
            "  web:",
            "    type: nginx",
            "    primary: true",
            "    port: 8123",
            "    webroot: public",
            ...(docker
              ? [
                  "    endpoints:",
                  "      - kind: published",
                  "        protocol: http",
                  "        port: 8123",
                  "        publication:",
                  "          bindAddress: 127.0.0.1",
                ]
              : ["    routes:", `      - hostname: ${hostname}`, "        scheme: http"]),
            "",
          ].join("\n"),
        );
        // When: the real binary validates, plans, starts, and observes the unmodified bundled launcher.
        const lint = Schema.decodeUnknownSync(lintEnvelope)(await appCli(root, ["app:config:lint"]));
        expect(lint.result.valid).toBe(true);
        await appCli(root, ["app:cache:refresh"]);
        try {
          const startAt = performance.now();
          const output = await appCli(root, ["start"], 300_000);
          const readyAt = performance.now();
          const started = decodeStart(output);
          const connection = started.servicesStarted
            .find((service) => service.name === "web")
            ?.connections.find(
              (connection) =>
                connection.binding === "assigned" &&
                (docker
                  ? connection.source === "publication"
                  : connection.source === "route" && connection.host === hostname),
            );
          if (connection?.url === undefined) throw new Error(`start reported no host URL for ${name}`);
          const url = new URL(connection.url);
          expect(url.hostname).toBe(docker ? "localhost" : hostname);
          const port = url.port || (url.protocol === "https:" ? "443" : "80");
          // Then: the reported host URL serves the exact unique body, without changing checkout permissions.
          const request = (target: URL) =>
            run(
              root,
              [
                "curl",
                "--silent",
                "--show-error",
                "--noproxy",
                "*",
                "--connect-timeout",
                "3",
                "--max-time",
                "5",
                "--resolve",
                `${url.hostname}:${port}:127.0.0.1`,
                "--header",
                `Host: ${url.host}`,
                // Trust relaxation is confined to this unique fixture host, with no redirects followed.
                ...(url.protocol === "https:" ? ["--insecure"] : []),
                "--write-out",
                "\n%{http_code}",
                target.href,
              ],
              30_000,
            );
          const response = await request(url);
          const firstHttpMs = performance.now() - readyAt;
          expect(response).toBe(`${body}\n200`);
          // Bridge setup skips Traefik; the first routed start must materialize it.
          if (provider === "podman") await expectRouterProvider();
          const missingStatus = (await request(new URL("/missing.html", url))).split("\n").at(-1);
          expect(missingStatus).toBe("404");
          const after = privateFiles ? await permissions() : undefined;
          if (privateFiles) expect(after).toEqual(before);
          expect(await Bun.file(index).text()).toBe(body);
          const info = Schema.decodeUnknownSync(infoEnvelope)(await appCli(root, ["info"])).result;
          const web = info.services.find((service) => service.service === "web");
          if (web === undefined) throw new Error(`info omitted web for ${name}`);
          expect(web.provider).toBe(provider);
          const projectIds = mapping === "image-renumber" ? { uid, gid } : { uid: 101, gid: 101 };
          if (privateFiles) expect(web.projectUser).toEqual({ name: "nginx", ...projectIds });
          const listener = web.connections.find((connection) => connection.scope === "app");
          expect(listener).toMatchObject({
            source: "listener",
            binding: "assigned",
            port: 8123,
            protocol: "http",
            state: "active",
          });
          if (!docker)
            expect(web.connections.some((connection) => connection.source === "publication")).toBe(false);
          const ingress = web.connections.find(
            (connection) =>
              connection.source === (docker ? "publication" : "route") && connection.host === url.hostname,
          );
          expect(ingress).toMatchObject({
            scope: "host",
            state: "active",
            endpoint: listener?.endpoint,
          });
          console.log(
            "NGINX_ROUTE_CLI_EVIDENCE",
            JSON.stringify({
              name,
              root,
              binary: cliBinary,
              provider,
              listener,
              ingress,
              status: 200,
              body,
              missingStatus: Number(missingStatus),
              privateFiles,
              before,
              after,
              startMs: readyAt - startAt,
              firstHttpMs,
            }),
          );
        } finally {
          await appCli(root, ["destroy", "--volumes", "--yes"], 90_000);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    720_000,
  );
});
