import { resolve } from "node:path";

import { expect, test } from "bun:test";

const childSource = String.raw`
  import { Effect } from "effect";
  import { makeInteractionService } from "./core/src/interaction/service.ts";

  const service = makeInteractionService({ defaultMode: "interactive" });
  const confirmed = await Effect.runPromise(
    Effect.scoped(service.confirm({ message: "Proceed?" })),
  );
  process.stdout.write("D11_CONFIRM_COMPLETE:" + String(confirmed) + "\n");
`;

test("interactive confirm child exits naturally after reading a line while parent keeps stdin open", async () => {
  // Given
  const proc = Bun.spawn([process.execPath, "--eval", childSource], {
    cwd: resolve(import.meta.dir, "../../.."),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutReader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let stdout = "";
  let guard: ReturnType<typeof setTimeout> | undefined;

  try {
    // When
    proc.stdin.write("y\n");
    await proc.stdin.flush();
    const completionMarker = (async (): Promise<void> => {
      while (!stdout.includes("D11_CONFIRM_COMPLETE:true")) {
        const chunk = await stdoutReader.read();
        if (chunk.done) throw new Error(`child stdout ended before completion marker: ${stdout}`);
        stdout += decoder.decode(chunk.value, { stream: true });
      }
    })();
    const failureGuard = new Promise<never>((_, reject) => {
      guard = setTimeout(() => reject(new Error("interactive confirm child did not exit naturally")), 2_000);
    });

    // Then
    await Promise.race([completionMarker, failureGuard]);
    expect(await Promise.race([proc.exited, failureGuard])).toBe(0);
  } finally {
    if (guard !== undefined) clearTimeout(guard);
    if (proc.exitCode === null) proc.kill();
    stdoutReader.releaseLock();
  }
});
