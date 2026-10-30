import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessRunner, type ProcessStreamEvent } from "@lando/sdk/services";
import { Effect, Stream } from "effect";
import * as BunProcessRunner from "../../src/services/process-runner.ts";

for (const capture of [false, true]) {
  test.skipIf(process.platform === "win32").each(["run", "stream", "streamWithExit"] as const)(
    `${capture ? "private " : ""}%s traverses symlink parents before selecting cwd and PWD`,
    async (mode) => {
      // Given: the lexical parent has a different marker from the native parent.
      const root = await mkdtemp(join(tmpdir(), "lando-context-"));
      try {
        await mkdir(join(root, "physical", "inside"), { recursive: true });
        await symlink("physical/inside", join(root, "link"));
        await writeFile(join(root, "marker"), "wrong");
        await writeFile(join(root, "physical", "marker"), "physical");
        const expected = await realpath(join(root, "physical"));
        const input = {
          cmd: process.execPath,
          args: [
            "-e",
            'process.stdout.write(JSON.stringify([process.cwd(), process.env.PWD, await Bun.file("marker").text()]))',
          ],
          cwd: `${root}/link/..`,
          capture,
        };
        // When
        const output = await Effect.runPromise(
          Effect.flatMap(ProcessRunner, (runner) => {
            if (mode === "run") return runner.run(input).pipe(Effect.map((result) => result.stdout));
            const stream = mode === "stream" ? runner.stream(input) : runner.streamWithExit(input);
            return Stream.runCollect(stream).pipe(
              Effect.map((events) => {
                const decoder = new TextDecoder();
                return events
                  .filter((event) => "kind" in event && event.kind === "stdout")
                  .map((event) => ("kind" in event ? decoder.decode(event.chunk) : ""))
                  .join("");
              }),
            );
          }).pipe(Effect.provide(BunProcessRunner.layer)),
        );
        // Then
        expect(JSON.parse(output)).toEqual([expected, expected, "physical"]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}

test.each(["run", "stream", "streamWithExit"] as const)(
  "%s replaces stale inherited PWD when cwd is omitted",
  async (mode) => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-default-cwd-"));
    try {
      await writeFile(join(root, "marker"), "default-directory");
      const cwd = await realpath(root);
      const source = `
        import { Effect, Stream } from ${JSON.stringify(import.meta.resolve("effect"))};
        import { ProcessRunner } from ${JSON.stringify(import.meta.resolve("@lando/sdk/services"))};
        import { layer } from ${JSON.stringify(import.meta.resolve("../../src/services/process-runner.ts"))};
        const input = { cmd: process.execPath, args: ["-e", 'process.stdout.write(JSON.stringify([process.cwd(),process.env.PWD,await Bun.file("marker").text()]))'] };
        const output = await Effect.runPromise(Effect.flatMap(ProcessRunner, runner => {
          ${mode === "run" ? "return runner.run(input).pipe(Effect.map(result => result.stdout));" : `return Stream.runCollect(runner.${mode}(input)).pipe(Effect.map(events => events.filter(event => event.kind === "stdout").map(event => new TextDecoder().decode(event.chunk)).join("")));`}
        }).pipe(Effect.provide(layer)));
        process.stdout.write(output);
      `;
      // When
      const child = Bun.spawn([process.execPath, "-e", source], {
        cwd: root,
        env: { ...process.env, PWD: "/stale-parent-pwd" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [output, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      // Then
      expect(exitCode, stderr).toBe(0);
      expect(JSON.parse(output)).toEqual([cwd, cwd, "default-directory"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32").each([
  ["missing", "run"],
  ["file", "stream"],
  ["broken", "streamWithExit"],
] as const)(
  "rejects %s before authored parent traversal through %s without spawning",
  async (component, mode) => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-invalid-cwd-"));
    const events: ProcessStreamEvent[] = [];
    try {
      await writeFile(join(root, "file"), "not a directory");
      await symlink("missing", join(root, "broken"));
      // When
      const result = await Effect.runPromise(
        Effect.flatMap(ProcessRunner, (runner) => {
          const input = {
            cmd: process.execPath,
            args: ["-e", "process.exit(0)"],
            cwd: `${root}/${component}/..`,
          };
          return mode === "run"
            ? runner.run(input).pipe(Effect.asVoid)
            : Stream.runForEach(
                mode === "stream" ? runner.stream(input) : runner.streamWithExit(input),
                (event) => Effect.sync(() => events.push(event)),
              );
        }).pipe(Effect.provide(BunProcessRunner.layer), Effect.result),
      );
      // Then
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({ _tag: "ProcessExecError", cwd: `${root}/${component}/..` });
        expect(result.failure.remediation).toMatch(/directory/i);
        expect(result.failure.cause).toMatchObject({ code: component === "file" ? "ENOTDIR" : "ENOENT" });
      }
      expect(events).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
