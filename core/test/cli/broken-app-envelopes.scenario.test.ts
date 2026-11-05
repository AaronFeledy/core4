import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { lastEnvelope, makeFixture, runSource } from "./subprocess-support";

// Dual-form start, hello, and stop are covered by tooling-router.scenario.test.ts.
const cases = [
  ["dual", "info", "app:info", "LandofileFormConflictError", 1],
  ["dual", "app:config", "app:config", "LandofileFormConflictError", 1],
  ["parse", "start", "app:start", "LandofileParseError", 1],
  ["parse", "info", "app:info", "LandofileParseError", 1],
  ["parse", "hello", "app:hello", "ToolingCommandUnavailableError", 1],
  ["parse", "stop", "app:stop", null, 0],
  ["parse", "app:config", "app:config", "LandofileParseError", 1],
  ["missing", "start", "app:start", "LandofileNotFoundError", 1],
  ["missing", "info", "app:info", "LandofileNotFoundError", 1],
  ["missing", "hello", "cli:unknown-command", "UnknownCommandError", 1],
  ["missing", "stop", "app:stop", "LandofileNotFoundError", 1],
  ["missing", "app:config", "app:config", "LandofileNotFoundError", 1],
  ["marker", "start", "app:start", "LandofileNotFoundError", 1],
  ["marker", "info", "app:info", "LandofileNotFoundError", 1],
  ["marker", "hello", "cli:unknown-command", "UnknownCommandError", 1],
  ["marker", "stop", "app:stop", "LandofileNotFoundError", 1],
  ["marker", "app:config", "app:config", "LandofileNotFoundError", 1],
] as const;

for (const [kind, command, commandId, errorTag, exitCode] of cases) {
  test(`${command} × ${kind} returns ${errorTag ?? "unchanged"} (exit ${exitCode})`, async () => {
    // Given
    const fixture = await makeFixture(`broken-${kind}-${command.replaceAll(":", "-")}`);
    try {
      const declaration = "tooling:\n  hello:\n    service: :host\n    cmd: echo hello\n";
      await writeFile(join(fixture.root, ".lando.yml"), `name: broken-app\n${declaration}`);
      const boundary = join(fixture.root, "boundary");
      let cwd = fixture.root;
      switch (kind) {
        case "dual":
          await writeFile(join(fixture.root, ".lando.ts"), 'export default { name: "broken-app" };\n');
          break;
        case "parse":
          await writeFile(
            join(fixture.root, ".lando.yml"),
            `${declaration}name: broken-app\nservices:\n\tweb: app\n`,
          );
          break;
        case "missing":
          await rm(join(fixture.root, ".lando.yml"));
          break;
        case "marker":
          cwd = join(boundary, "child");
          await mkdir(cwd, { recursive: true });
          await writeFile(join(boundary, ".lando.stop"), "");
          break;
        default: {
          const unreachable: never = kind;
          throw unreachable;
        }
      }
      const preload = join(fixture.root, "deny-network.ts");
      await writeFile(
        preload,
        [
          'import { Socket } from "node:net";',
          'const deny = () => { throw new Error("Network denied by broken-app suite"); };',
          "globalThis.fetch = deny;",
          "Bun.connect = deny;",
          "Socket.prototype.connect = deny;",
        ].join("\n"),
      );
      // When
      const result = await runSource(
        { ...fixture, root: cwd },
        [command, "--format=json"],
        ["--preload", preload],
      );
      // Then
      expect(result.exitCode, result.stderr + result.stdout).toBe(exitCode);
      const envelope = lastEnvelope(result.stdout);
      expect(envelope).toMatchObject({ command: commandId, ok: errorTag === null });
      if (errorTag === null) {
        expect(envelope).toMatchObject({ result: { outcome: "unchanged" } });
      } else {
        const error = envelope.error;
        if (error === null || typeof error !== "object") throw new Error("Expected an error object");
        const diagnostic = Object.fromEntries(Object.entries(error));
        expect(diagnostic._tag).toBe(errorTag);
        expect(diagnostic.remediation).toMatch(/\S/u);
        if (errorTag === "ToolingCommandUnavailableError") {
          expect(diagnostic).toMatchObject({
            reason: "missing-cache",
            sourcePath: join(fixture.root, ".lando.yml"),
            remediation: expect.stringContaining("lando app:cache:refresh"),
          });
        }
      }
      if (errorTag === "LandofileNotFoundError") {
        expect(lastEnvelope(result.stdout)).toMatchObject({
          error: {
            message: expect.stringContaining(
              kind === "marker" ? `.lando.stop at ${boundary}` : "filesystem root",
            ),
          },
        });
        if (kind === "marker") {
          expect(lastEnvelope(result.stdout)).toMatchObject({
            error: { remediation: expect.stringContaining(`move/remove the .lando.stop at ${boundary}`) },
          });
        }
      }
      expect(result.stdout).not.toMatch(/\n\s+at |"stack"\s*:/u);
      expect(result.stderr).not.toMatch(/\n\s+at |"stack"\s*:/u);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);
}
