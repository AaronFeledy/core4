import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type LandoEvent, LockWaitEvent } from "@lando/sdk/events";
import { EventService } from "@lando/sdk/services";
import { Effect, Layer, Queue, Schema, Stream } from "effect";
import { ADVISORY_LOCK_SUFFIX, acquireAdvisoryLockAt, withAdvisoryLockUsing } from "../../src/lock.ts";
import type { HolderPhase } from "./fixtures/advisory-lock-holder.ts";
import { lockTestAccess } from "./lock-test-access.ts";

const holderFixturePath = fileURLToPath(new URL("./fixtures/advisory-lock-holder.ts", import.meta.url));

export const withAdvisoryLock = withAdvisoryLockUsing(lockTestAccess);

/** Run an effect that requires Scope by closing the scope at the end. */
export const runWithScope = <A, E>(effect: Effect.Effect<A, E, import("effect").Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.scoped(effect));

export const sentinelPath = (dir: string, name = "target"): string =>
  join(dir, `${name}${ADVISORY_LOCK_SUFFIX}`);

export const tempLockDir = async (): Promise<string> => mkdtemp(join(tmpdir(), "lando-native-lock-"));

export const removeDir = async (dir: string): Promise<void> => {
  await rm(dir, { recursive: true, force: true });
};

export type HolderChild = {
  readonly process: ReturnType<typeof Bun.spawn>;
  readonly pid: number;
  readonly token: string;
  readonly release: () => void;
  readonly exited: Promise<number>;
  readonly stderr: Promise<string>;
};

const readReadyLine = async (
  stdout: ReadableStream<Uint8Array>,
  label: string,
  phase: HolderPhase | undefined,
): Promise<{ pid: number; token: string }> => {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const signal = AbortSignal.timeout(phase === undefined ? 15_000 : 4_000);
  const timedOut = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error(`${label}: timed out waiting for ready`)), {
      once: true,
    });
  });
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), timedOut]);
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd === -1) continue;
      const line = buffer.slice(0, lineEnd).trim();
      const match = /^ready (\d+) (\S+)(?: (opened|locked|recorded))?$/u.exec(line);
      if (match === null || match[3] !== phase)
        throw new Error(`${label}: unexpected ready line ${JSON.stringify(line)} (phase=${phase})`);
      return { pid: Number(match[1]), token: match[2] ?? "" };
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error(`${label}: stdout closed before ready (buffer=${JSON.stringify(buffer)})`);
};

export const spawnHolder = async (
  command: readonly string[],
  sentinel: string,
  options: {
    readonly mode?: "exclusive" | "shared";
    readonly resource?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly pauseAt?: HolderPhase;
  } = {},
): Promise<HolderChild> => {
  const mode = options.mode ?? "exclusive";
  const args = [sentinel, mode, ...(options.resource === undefined ? [] : [options.resource])];
  const child = Bun.spawn([...command, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...options.env, LANDO_TEST_LOCK_PAUSE_AT: options.pauseAt ?? "" },
    windowsHide: true,
  });
  const stderr = new Response(child.stderr).text();
  try {
    const ready = await readReadyLine(child.stdout, `holder ${sentinel}`, options.pauseAt);
    return {
      process: child,
      pid: ready.pid,
      token: ready.token,
      release: () => {
        try {
          child.stdin.end();
        } catch {
          // already closed
        }
      },
      exited: child.exited,
      stderr,
    };
  } catch (error) {
    child.kill();
    await child.exited.catch(() => undefined);
    const detail = await stderr.catch(() => "");
    throw new Error(`${String(error)}\nstderr: ${detail}`);
  }
};

export const sourceHolderCommand = (): readonly string[] => [process.execPath, holderFixturePath];

export const compileHolder = async (outfile: string, timeoutMs = 120_000): Promise<void> => {
  const compile = Bun.spawn(
    [process.execPath, "build", "--compile", holderFixturePath, "--outfile", outfile],
    { stdout: "pipe", stderr: "pipe" },
  );
  const result = await Promise.race([
    Promise.all([compile.exited, new Response(compile.stdout).text(), new Response(compile.stderr).text()]),
    Bun.sleep(timeoutMs).then(() => null),
  ]);
  if (result === null) {
    compile.kill();
    await compile.exited.catch(() => undefined);
    throw new Error(`compile holder timed out after ${timeoutMs}ms`);
  }
  const [code, stdout, stderr] = result;
  if (code !== 0) throw new Error(`compile holder failed (${code}):\n${stdout}\n${stderr}`);
};

/** EventService that records warns and can signal first contention via Deferred. */
export const capturingEventLayer = (
  events: LandoEvent[],
  onWait?: (event: LockWaitEvent) => Effect.Effect<void>,
): Layer.Layer<EventService> =>
  Layer.effect(
    EventService,
    Effect.gen(function* () {
      const subscribers = new Set<Queue.Queue<LandoEvent>>();
      return EventService.of({
        publish: (event) =>
          Effect.gen(function* () {
            events.push(event as LandoEvent);
            for (const queue of subscribers) yield* Queue.offer(queue, event as LandoEvent);
            if (onWait !== undefined && Schema.is(LockWaitEvent)(event)) yield* onWait(event);
          }),
        subscribe: () => Stream.empty,
        subscribeQueue: Effect.acquireRelease(
          Queue.unbounded<LandoEvent>().pipe(
            Effect.tap((queue) => Effect.sync(() => subscribers.add(queue))),
          ),
          (queue) => Effect.sync(() => subscribers.delete(queue)),
        ),
        waitFor: () => Effect.never,
        subscribeWithHistory: () => Effect.never,
        waitForAny: () => Effect.never,
        query: () => Effect.succeed([]),
      });
    }),
  );

export const acquireExclusive = (
  sentinel: string,
  options: {
    readonly timeoutMs?: number;
    readonly resource?: string;
    readonly wait?: "brief" | "operation";
  } = {},
) =>
  acquireAdvisoryLockAt(sentinel, "test", {
    privateFileAccess: lockTestAccess,
    mode: "exclusive",
    ...options,
  });

export const acquireShared = (
  sentinel: string,
  options: {
    readonly timeoutMs?: number;
    readonly resource?: string;
  } = {},
) =>
  acquireAdvisoryLockAt(sentinel, "test", {
    privateFileAccess: lockTestAccess,
    mode: "shared",
    ...options,
  });
