import { Schema } from "effect";
import type { PrivateFileAccessProcess, PrivateFileAccessSpawn } from "../src/private-file-worker.ts";

const WorkerRequest = Schema.Struct({
  id: Schema.String,
  operation: Schema.Literal("enforce", "verify"),
  path: Schema.String,
});
const WorkerFrame = Schema.Struct({
  id: Schema.String,
  operation: Schema.Literal("enforce", "verify"),
  pathBase64: Schema.String,
});

export type WorkerRequest = typeof WorkerRequest.Type;
export type WorkerOutcome =
  | { readonly kind: "response"; readonly line?: string; readonly ok?: boolean }
  | { readonly kind: "exit"; readonly code: number };

export interface RecordingWorkerSpawn {
  readonly spawn: PrivateFileAccessSpawn;
  readonly commands: ReadonlyArray<ReadonlyArray<string>>;
  readonly requests: ReadonlyArray<WorkerRequest>;
  readonly frames: ReadonlyArray<Uint8Array>;
  readonly firstRequest: Promise<void>;
  readonly spawnCount: () => number;
  readonly killCount: () => number;
}

export const makeRecordingWorkerSpawn = (
  respond: (request: WorkerRequest) => WorkerOutcome | Promise<WorkerOutcome> = () => ({
    kind: "response",
    ok: true,
  }),
): RecordingWorkerSpawn => {
  const requests: WorkerRequest[] = [];
  const frames: Uint8Array[] = [];
  const commands: Array<ReadonlyArray<string>> = [];
  let spawns = 0;
  let kills = 0;
  let resolveFirstRequest: () => void = () => undefined;
  const firstRequest = new Promise<void>((resolve) => {
    resolveFirstRequest = resolve;
  });
  const spawn: PrivateFileAccessSpawn = (command) => {
    spawns += 1;
    commands.push(command);
    let exitCode: number | null = null;
    let resolveExit: (code: number) => void = () => undefined;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stdout = new ReadableStream<Uint8Array>({
      start: (controller) => {
        stdoutController = controller;
      },
    });
    const stderr = new ReadableStream<Uint8Array>({
      start: (controller) => controller.close(),
    });
    const finish = (code: number): void => {
      if (exitCode !== null) return;
      exitCode = code;
      stdoutController?.close();
      resolveExit(code);
    };
    const processHandle: PrivateFileAccessProcess = {
      stdin: {
        write: (data) => {
          frames.push(typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data));
          const text = typeof data === "string" ? data : new TextDecoder().decode(data);
          const frame = Schema.decodeUnknownSync(WorkerFrame, { onExcessProperty: "error" })(
            JSON.parse(text.trim()),
          );
          const request = {
            id: frame.id,
            operation: frame.operation,
            path: Buffer.from(frame.pathBase64, "base64").toString("utf16le"),
          };
          requests.push(request);
          resolveFirstRequest();
          Promise.resolve(respond(request)).then(
            (outcome) => {
              if (outcome.kind === "exit") {
                finish(outcome.code);
                return;
              }
              const line = outcome.line ?? JSON.stringify({ id: request.id, ok: outcome.ok ?? true });
              stdoutController?.enqueue(new TextEncoder().encode(`${line}\n`));
            },
            (cause) => stdoutController?.error(cause),
          );
          return text.length;
        },
        flush: () => 0,
        end: () => 0,
      },
      stdout,
      stderr,
      exited,
      get exitCode() {
        return exitCode;
      },
      kill: () => {
        kills += 1;
        finish(0);
      },
    };
    return processHandle;
  };
  return {
    spawn,
    commands,
    requests,
    frames,
    firstRequest,
    spawnCount: () => spawns,
    killCount: () => kills,
  };
};
