import { SUPPORTED_PHP_VERSIONS } from "../plugins/service-lando/src/services/php-via.ts";
import { phpXdebugBuildStep } from "../plugins/service-lando/src/services/php-xdebug.ts";
import pins from "../plugins/service-lando/src/services/php-xdebug-pins.json" with { type: "json" };

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 0) throw new TypeError("Usage: bun run scripts/check-xdebug-build.ts <php-version>...");
  const versions = args.map((arg) => {
    const version = SUPPORTED_PHP_VERSIONS.find((version) => version === arg);
    if (version === undefined) throw new TypeError(`Unsupported PHP version: ${arg}`);
    return version;
  });
  // Builds run concurrently so a release that moves every PHP version still fits the job timeout.
  const results = await Promise.all(
    versions.map(async (version) => {
      const pin = pins.releases[version];
      const image = `php:${version}-cli-bookworm`;
      const { command } = phpXdebugBuildStep(version, { mode: "debug" });
      const verify = `php -r 'exit(phpversion("xdebug") === "${pin.version}" ? 0 : 1);'`;
      const child = Bun.spawn(["docker", "run", "--rm", image, "sh", "-c", `${command} && ${verify}`], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { image, pin, exitCode, stdout, stderr };
    }),
  );
  for (const { image, pin, exitCode, stdout, stderr } of results) {
    if (exitCode === 0) {
      process.stdout.write(`${image}: Xdebug ${pin.version} built and loaded.\n`);
    } else {
      process.stderr.write(
        `${image}: Xdebug ${pin.version} build check failed (exit ${exitCode}).\n${stdout.slice(-4000)}\n${stderr.slice(-4000)}\n`,
      );
      process.exitCode = 1;
    }
  }
}
