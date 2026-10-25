import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PHP_BASELINE_INI_PATH,
  PHP_SECURITY_BASELINE,
  renderPhpBaselineIni,
} from "../src/services/php-baseline.ts";
import { type PhpVia, phpImageFor } from "../src/services/php-via.ts";
import { SUPPORTED_PHP_VERSIONS } from "../src/services/php.ts";

const dockerHost = process.env.LANDO_TEST_DOCKER_SOCKET ?? process.env.DOCKER_HOST;
const servingModes = ["apache", "fpm"] as const satisfies ReadonlyArray<Exclude<PhpVia, "cli">>;

const resolveDockerCli = (): string => {
  const found = Bun.spawnSync(["which", "docker"], { stdout: "pipe", stderr: "ignore" });
  if (found.exitCode !== 0) {
    throw new Error("docker is required when LANDO_TEST_DOCKER_SOCKET or DOCKER_HOST is set");
  }
  return new TextDecoder().decode(found.stdout).trim();
};

const dockerEnv = (): NodeJS.ProcessEnv => {
  if (process.env.LANDO_TEST_DOCKER_SOCKET === undefined) return process.env;
  const socket = process.env.LANDO_TEST_DOCKER_SOCKET;
  const host = socket.startsWith("/") ? `unix://${socket}` : socket;
  return { ...process.env, DOCKER_HOST: host };
};

const phpAssertion = (): string =>
  PHP_SECURITY_BASELINE.map((entry) => {
    const setting = JSON.stringify(entry.setting);
    const expected = JSON.stringify(entry.value);
    return `$actual = ini_get(${setting}); if ($actual !== ${expected}) { fwrite(STDERR, ${setting} . '=' . var_export($actual, true) . "\\n"); exit(1); } echo ${setting}, '=', $actual, "\\n";`;
  }).join(" ");

const runImage = async (
  docker: string,
  image: string,
  iniHostPath: string,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  const proc = Bun.spawn(
    [
      docker,
      "run",
      "--rm",
      "-v",
      `${iniHostPath}:${PHP_BASELINE_INI_PATH}:ro`,
      image,
      "php",
      "-r",
      phpAssertion(),
    ],
    {
      env: dockerEnv(),
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

const matrix = SUPPORTED_PHP_VERSIONS.flatMap((version) =>
  servingModes.map((via) => ({ version, via, image: phpImageFor(version, via) })),
);

describe("PHP security baseline — official images", () => {
  test.skipIf(dockerHost === undefined).each(matrix)(
    "applies the baseline on $image without PHP Warning or PHP Startup",
    async ({ image }) => {
      // Given: the rendered table mounted onto an official Hub PHP image.
      expect(dockerHost).toBeDefined();
      const docker = resolveDockerCli();
      const root = await mkdtemp(join(tmpdir(), "lando-php-baseline-"));
      const iniHostPath = join(root, "10-lando-baseline.ini");
      await writeFile(iniHostPath, renderPhpBaselineIni());
      try {
        // When: php loads the Lando-managed conf.d drop-in.
        const result = await runImage(docker, image, iniHostPath);

        // Then: stderr stays free of startup diagnostics and ini_get matches the table.
        expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(result.stderr).not.toMatch(/PHP Warning/);
        expect(result.stderr).not.toMatch(/PHP Startup/);
        for (const entry of PHP_SECURITY_BASELINE) {
          expect(result.stdout).toContain(`${entry.setting}=${entry.value}`);
        }
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    },
    600_000,
  );
});
