import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tcpProbe } from "../src/services/_tcp-probe.ts";
import { TOMCAT_CATALOG } from "../src/services/generated/tomcat-catalog.ts";
import { SUPPORTED_PHP_VERSIONS, phpImageFor } from "../src/services/php-via.ts";

const images = [
  { image: "mongo:7", port: 27017, command: [] },
  ...["3", "4"].map((version) => ({ image: `rabbitmq:${version}-management`, port: 5672, command: [] })),
  { image: "memcached:1.6", port: 11211, command: ["memcached", "-p", "11211"] },
  {
    image: "valkey/valkey:8",
    port: 6379,
    command: ["valkey-server", "--appendonly", "yes", "--port", "6379"],
  },
  ...Object.values(TOMCAT_CATALOG).map(({ image }) => ({ image, port: 8080, command: [] })),
  ...["5", "latest"].map((version) => ({ image: `phpmyadmin:${version}`, port: 80, command: [] })),
  ...SUPPORTED_PHP_VERSIONS.flatMap((version) => [
    { image: phpImageFor(version, "apache"), port: 80, command: [] },
    { image: phpImageFor(version, "fpm"), port: 9000, command: [] },
  ]),
  { image: "nginx:1.26-alpine", port: 80, command: [] },
  { image: "httpd:2.4-alpine", port: 80, command: [] },
  {
    image: "caddy:2-alpine",
    port: 80,
    command: ["caddy", "file-server", "--listen", ":80", "--root", "/srv"],
  },
] as const;

test.skipIf(process.env.LANDO_TEST_PODMAN_SOCKET === undefined).each(images)(
  "TCP probe is portable on $image:$port",
  async ({ image, port, command }) => {
    // Given: the catalog image's default daemon on its own non-loopback container IP.
    const socket = process.env.LANDO_TEST_PODMAN_SOCKET;
    const binary = Bun.which("podman");
    if (socket === undefined || binary === null)
      throw new Error("Live portability needs the Podman socket and CLI on PATH");
    const name = `lando-tcp-portability-${randomUUID()}`;
    const run = async (args: readonly string[]) => {
      const child = Bun.spawn([binary, "--url", `unix://${socket}`, ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exit, stdout, stderr };
    };
    const launched = await run(["run", "-d", "--network", "podman", "--name", name, image, ...command]);
    try {
      expect(launched.exit, launched.stderr).toBe(0);
      const inspected = await run([
        "inspect",
        "--format",
        "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
        name,
      ]);
      expect(inspected.exit, inspected.stderr).toBe(0);
      const host = inspected.stdout.trim();
      expect(host).not.toBe("");
      expect(host).not.toMatch(/^127\./);
      const tools = await run([
        "exec",
        name,
        "sh",
        "-c",
        "for tool in bash nc timeout; do command -v $tool || :; done",
      ]);
      expect(tools.exit, tools.stderr).toBe(0);
      const probe = tcpProbe(port, 10);
      let observed = { exit: 1, stdout: "", stderr: "daemon has not started" };
      // When: the exact generated argv dials that IP, not loopback, after startup.
      for (let attempt = 0; attempt < 60; attempt++) {
        observed = await run([
          "exec",
          "--env",
          `LANDO_PROBE_HOST=${host}`,
          "--env",
          `LANDO_PROBE_PORT=${port}`,
          name,
          ...probe.command,
        ]);
        if (observed.exit === 0) break;
        await Bun.sleep(1000);
      }
      // Then: accepting a connection on the non-loopback IP proves the default bind is reachable.
      expect(observed.exit, `${image}: ${observed.stderr}`).toBe(0);
      console.log(
        JSON.stringify({
          image,
          host,
          port,
          tools: tools.stdout.trim().split("\n"),
          probeExit: observed.exit,
          nonLoopback: true,
        }),
      );
    } finally {
      const removed = await run(["rm", "--force", "--volumes", name]);
      expect(removed.exit, removed.stderr).toBe(0);
    }
  },
  240_000,
);
