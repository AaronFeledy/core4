import { expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";

const socket = resolveLiveProviderSocket();

/**
 * Proves the project-user contract on the managed runtime: files a PHP service,
 * `lando exec`, tooling, and Apache workers write belong to the host user, and
 * an unchanged second start reuses the container.
 */
test.skipIf(socket === undefined || process.platform !== "linux")(
  "the project user owns what a PHP app writes on the managed provider",
  async () => {
    if (socket === undefined) throw new Error("A live Podman socket is required");
    const providerId = process.env.LANDO_CONFIG__default_provider_id ?? "lando";
    expect(["lando", "podman"], "Run against the managed provider or rootless Podman").toContain(providerId);
    const hostOwnerId = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
    const root = await mkdtemp(join(tmpdir(), "lando-project-user-live-"));
    const nonce = crypto.randomUUID().slice(0, 8);
    const name = `pu-live-${nonce}`;
    const service = "app";
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
      return { exitCode, stdout, stderr };
    };
    const must = async (args: readonly string[]) => {
      const result = await lando(args);
      expect(result.exitCode, `${args.join(" ")}\n${result.stdout}${result.stderr}`).toBe(0);
      return result;
    };
    const hostOwner = async (path: string) => {
      const info = await stat(path);
      return `${info.uid}:${info.gid}`;
    };
    const pidNamespace = async (): Promise<string> =>
      (
        await must(["exec", "--user", "root", service, "--", "stat", "-Lc", "%i", "/proc/1/ns/pid"])
      ).stdout.trim();

    const landofile = [
      `name: ${name}`,
      "runtime: 4",
      `provider: ${providerId}`,
      "router:",
      "  enabled: false",
      "services:",
      `  ${service}:`,
      "    type: php:8.3",
      "    via: apache",
      "    primary: true",
      "    xdebug: true",
      "    appMount:",
      "      target: /app",
      "      excludes: [vendor]",
      "tooling:",
      "  php:",
      `    service: ${service}`,
      "    cmd: php",
      "  composer:",
      `    service: ${service}`,
      "    cmd: composer",
      "",
    ].join("\n");

    try {
      await writeFile(join(root, ".lando.yml"), landofile);
      await writeFile(join(root, "index.php"), "<?php echo 'served';");
      await writeFile(
        join(root, "write.php"),
        [
          "<?php",
          "$dir = __DIR__;",
          "file_put_contents($dir . '/worker.txt', 'worker');",
          "file_put_contents($dir . '/host.txt', ' appended', FILE_APPEND);",
          "echo 'worker-ok';",
          "",
        ].join("\n"),
      );
      await writeFile(join(root, "host.txt"), "host");
      await must(["start", "--format=json"]);
      const started = await pidNamespace();
      expect(started, "the service container must exist").toMatch(/^[0-9]+$/);

      // The login identity is the project user, with its persisted home.
      const identity = await must([
        "exec",
        service,
        "--",
        "sh",
        "-c",
        'id -u; id -g; id -un; echo "$HOME"; echo "$LANDO_USER/$LANDO_UID/$LANDO_GID"',
      ]);
      expect(identity.stdout.trim().split("\n")).toEqual([
        "33",
        "33",
        "www-data",
        "/var/www",
        "www-data/33/33",
      ]);

      // A command-created file is host-owned.
      await must(["exec", service, "--", "sh", "-c", "printf exec > /app/exec.txt"]);
      expect(await hostOwner(join(root, "exec.txt"))).toBe(hostOwnerId);

      // Tooling creates a host-owned file too.
      const tooling = await must(["php", "-r", "file_put_contents('/app/tooling.txt', 'tooling');"]);
      expect(tooling.exitCode).toBe(0);
      expect(await hostOwner(join(root, "tooling.txt"))).toBe(hostOwnerId);

      // The Apache worker writes through the request, and can append to a host-created file.
      const served = await must([
        "exec",
        service,
        "--",
        "php",
        "-r",
        "echo file_get_contents('http://127.0.0.1/write.php');",
      ]);
      expect(served.stdout).toContain("worker-ok");
      expect(await hostOwner(join(root, "worker.txt"))).toBe(hostOwnerId);
      expect((await Bun.file(join(root, "host.txt")).text()).trim()).toBe("host appended");

      // An empty exclude shadow accepts create, edit, rename, and delete as the project user.
      await must([
        "exec",
        service,
        "--",
        "sh",
        "-c",
        "mkdir -p /app/vendor && printf one > /app/vendor/a.txt && printf two > /app/vendor/a.txt && mv /app/vendor/a.txt /app/vendor/b.txt && rm /app/vendor/b.txt",
      ]);

      // Home persistence follows the project user and is writable.
      await must(["exec", service, "--", "sh", "-c", 'printf home > "$HOME/.lando-project-user"']);

      // Composer writes host-owned project files.
      const composer = await must(["composer", "require", "psr/log", "--no-interaction"]);
      expect(composer.exitCode).toBe(0);
      expect(await hostOwner(join(root, "composer.json"))).toBe(hostOwnerId);

      // Explicit root stays available.
      const rootIdentity = await must(["exec", "--user", "root", service, "--", "sh", "-c", "id -u; id -un"]);
      expect(rootIdentity.stdout.trim().split("\n")).toEqual(["0", "root"]);

      // Apache serves the app.
      const page = await must([
        "exec",
        service,
        "--",
        "php",
        "-r",
        "echo file_get_contents('http://127.0.0.1/');",
      ]);
      expect(page.stdout).toContain("served");

      // Xdebug's admin task keeps root.
      await must(["xdebug", "off"]);

      // An unchanged second start reuses the container.
      await must(["start", "--format=json"]);
      expect(await pidNamespace()).toBe(started);
    } finally {
      await lando(["destroy", "--yes", "--volumes", "--purge-caches", "--format=json"]);
      await rm(root, { recursive: true, force: true });
    }
  },
  1_200_000,
);

test.skipIf(socket === undefined || process.platform !== "linux")(
  "a fresh PHP webroot and exclude shadow are host-owned before the container starts",
  async () => {
    if (socket === undefined) throw new Error("A live Podman socket is required");
    const providerId = process.env.LANDO_CONFIG__default_provider_id ?? "lando";
    expect(["lando", "podman"], "Run against the managed provider or rootless Podman").toContain(providerId);
    const hostOwnerId = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
    const root = await mkdtemp(join(tmpdir(), "lando-project-user-webroot-"));
    const nonce = crypto.randomUUID().slice(0, 8);
    const name = `fx-pu-webroot-${nonce}`;
    const service = "app";
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
      return { exitCode, stdout, stderr };
    };
    const must = async (args: readonly string[]) => {
      const result = await lando(args);
      expect(result.exitCode, `${args.join(" ")}\n${result.stdout}${result.stderr}`).toBe(0);
      return result;
    };
    const hostOwner = async (path: string) => {
      const info = await stat(path);
      return `${info.uid}:${info.gid}`;
    };
    const exists = (path: string) =>
      stat(path).then(
        () => true,
        () => false,
      );
    const landofile = [
      `name: ${name}`,
      "runtime: 4",
      `provider: ${providerId}`,
      "router:",
      "  enabled: false",
      "services:",
      `  ${service}:`,
      "    type: php:8.3",
      "    via: apache",
      "    primary: true",
      "    webroot: web",
      "    appMount:",
      "      target: /app",
      "      excludes: [vendor]",
      "",
    ].join("\n");

    try {
      await writeFile(join(root, ".lando.yml"), landofile);
      await writeFile(join(root, "index.php"), "<?php echo 'served';");
      expect(await exists(join(root, "web")), "the fixture starts without a host webroot").toBe(false);

      await must(["start", "--format=json"]);

      // The runtime would have created these as container root; Lando creates them as the host user.
      for (const directory of ["web", "vendor"]) {
        const info = await stat(join(root, directory));
        expect(info.isDirectory(), `${directory} must exist as a directory`).toBe(true);
        expect(`${info.uid}:${info.gid}`, `${directory} must belong to the host user`).toBe(hostOwnerId);
      }

      // The project user can create in the working directory the runtime would have made.
      await must(["exec", service, "--", "sh", "-c", "printf project > /app/web/project.txt"]);
      expect(await hostOwner(join(root, "web/project.txt"))).toBe(hostOwnerId);

      // The host user can create in the same directory.
      await writeFile(join(root, "web/host.txt"), "host");
      expect((await Bun.file(join(root, "web/host.txt")).text()).trim()).toBe("host");
    } finally {
      await lando(["destroy", "--yes", "--volumes", "--purge-caches", "--format=json"]);
      await rm(root, { recursive: true, force: true });
    }
  },
  1_200_000,
);
