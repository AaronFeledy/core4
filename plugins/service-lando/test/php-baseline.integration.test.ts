import { describe, expect, test } from "bun:test";

import {
  PHP_SECURITY_BASELINE,
  phpBaselineIniCommand,
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

const imageCommand = (): string => {
  const assertion = phpAssertion();
  if (assertion.includes("'")) {
    throw new Error("PHP baseline assertion cannot contain single quotes");
  }
  return `${phpBaselineIniCommand(renderPhpBaselineIni())} && php -r '${assertion}'`;
};

const runImage = async (
  docker: string,
  image: string,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  const proc = Bun.spawn([docker, "run", "--rm", image, "sh", "-c", imageCommand()], {
    env: dockerEnv(),
    stderr: "pipe",
    stdout: "pipe",
  });
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
      // Given: the shipped printf command on an official Hub PHP image.
      expect(dockerHost).toBeDefined();
      const docker = resolveDockerCli();

      // When: the container writes the Lando-managed conf.d drop-in, then php reads it.
      const result = await runImage(docker, image);

      // Then: stderr stays free of startup diagnostics and ini_get matches the table.
      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stderr).not.toMatch(/PHP Warning/);
      expect(result.stderr).not.toMatch(/PHP Startup/);
      for (const entry of PHP_SECURITY_BASELINE) {
        expect(result.stdout).toContain(`${entry.setting}=${entry.value}`);
      }
    },
    600_000,
  );
});
