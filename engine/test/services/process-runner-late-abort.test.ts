import { expect, spyOn, test } from "bun:test";
import { Cause, Effect, Exit, Stream } from "effect";
import { service } from "../../src/services/process-runner.ts";

const withinDeadline = <A>(promise: Promise<A>) =>
  Effect.runPromise(Effect.promise(() => promise).pipe(Effect.timeout("2 seconds")));

const spawnObservedBy = (spawn: ReturnType<typeof spyOn<typeof Bun, "spawn">>, source: string) => {
  const index = spawn.mock.calls.findIndex(([argv]) => Array.isArray(argv) && argv.includes(source));
  const child = spawn.mock.results[index]?.value;
  if (
    typeof child !== "object" ||
    child === null ||
    !("exited" in child) ||
    !(child.exited instanceof Promise)
  )
    throw new TypeError("Could not observe the child exit");
  return child.exited;
};

for (const mode of ["captured request", "captured fiber", "ordinary request", "stream request"] as const) {
  test.skipIf(process.platform === "win32")(
    `bounds a late ${mode} abort with inherited pipes open`,
    async () => {
      const ready = Promise.withResolvers<{ readonly ping: () => void; readonly stop: () => void }>();
      const responded = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<void>();
      const sinkBlocked = Promise.withResolvers<void>();
      const releaseSink = Promise.withResolvers<void>();
      const server = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: {
          data(socket, bytes) {
            if (bytes.includes(0x2b))
              ready.resolve({ ping: () => socket.write("?"), stop: () => socket.end() });
            if (bytes.includes(0x21)) responded.resolve();
          },
          close() {
            closed.resolve();
          },
        },
      });
      const descendant = `await Bun.connect({hostname:"127.0.0.1",port:${server.port},socket:{
      open(socket){socket.write("+")},data(socket){socket.write("!")},close(){process.exit(0)}
    }});
    ${
      mode === "stream request"
        ? `process.stdout.on("error", () => {});
           const chunk = "x".repeat(65536);
           for (let i = 0; i < 64; i++) {
             if (!process.stdout.write(chunk)) await new Promise(resolve => process.stdout.once("drain", resolve));
           }`
        : ""
    }`;
      // The descendant must outlive this shell even if Bun starts before the shell exits.
      // The socket, not Bun's inherited parent-death watchdog, owns fixture teardown.
      const leader = 'unset BUN_FEATURE_FLAG_NO_ORPHANS; "$1" -e "$2" </dev/null & exit 7';
      const spawn = spyOn(Bun, "spawn");
      const controller = new AbortController();
      let released = false;
      let peer: Awaited<typeof ready.promise> | undefined;
      const request = {
        cmd: "sh",
        args: ["-c", leader, "lando-test", process.execPath, descendant],
        ...(mode === "captured fiber" || mode === "captured request" ? { capture: true } : {}),
        ...(mode === "captured fiber" ? {} : { signal: controller.signal }),
      };
      const run =
        mode === "stream request"
          ? service.streamWithExit(request).pipe(
              Stream.runForEach((event) =>
                "kind" in event
                  ? Effect.promise(() => {
                      sinkBlocked.resolve();
                      return releaseSink.promise;
                    })
                  : Effect.die(new TypeError(`An incomplete stream reported status ${event.exitCode}`)),
              ),
            )
          : service.run(request).pipe(Effect.asVoid);
      const completion = Effect.runPromiseExit(
        run.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              released = true;
            }),
          ),
        ),
        mode === "captured fiber" ? { signal: controller.signal } : {},
      );
      try {
        peer = await withinDeadline(ready.promise);
        expect(await withinDeadline(spawnObservedBy(spawn, leader))).toBe(7);
        if (mode === "stream request") await withinDeadline(sinkBlocked.promise);
        expect(released).toBe(false);

        controller.abort();
        releaseSink.resolve();
        const exit = await withinDeadline(completion);

        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
        expect(released).toBe(true);
        // The old leader ID is not authority to signal this descendant.
        peer.ping();
        await withinDeadline(responded.promise);
      } finally {
        controller.abort();
        releaseSink.resolve();
        spawn.mockRestore();
        try {
          peer?.stop();
          if (peer !== undefined) await withinDeadline(closed.promise);
        } finally {
          server.stop(true);
          await withinDeadline(completion);
        }
      }
    },
    6500,
  );
}

test.each([0, 7])("keeps drained process exit %i on a late request abort", async (code) => {
  const spawn = spyOn(Bun, "spawn");
  const controller = new AbortController();
  const source = `process.exit(${code});`;
  try {
    const result = await withinDeadline(
      Effect.runPromise(
        service.run({
          cmd: process.execPath,
          args: ["-e", source],
          inheritOutput: true,
          signal: controller.signal,
          stdinStream: {
            [Symbol.asyncIterator]() {
              // Attach before the runner's exit wait, with no owned output left to drain.
              void spawnObservedBy(spawn, source).then(() => controller.abort());
              return { next: () => new Promise<IteratorResult<Uint8Array>>(() => {}) };
            },
          },
        }),
      ),
    );
    expect(controller.signal.aborted).toBe(true);
    expect(result).toMatchObject({ exitCode: code, stdout: "", stderr: "" });
  } finally {
    controller.abort();
    spawn.mockRestore();
  }
});
