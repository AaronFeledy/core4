#!/usr/bin/env bun
// Linux amd64 test fixture only. Builds through the explicit engine socket, not host Go.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import {
  assertImageBuild,
  minioQaInputs,
  verifyQaInput,
} from "../plugins/service-lando/test/support/minio-qa-image.ts";

const run = async (argv: readonly string[]): Promise<string> => {
  const child = Bun.spawn([...argv], { stdout: "pipe", stderr: "inherit", timeout: 1_200_000 });
  const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  if (code !== 0) throw new Error(`${argv[0]} failed with exit ${code}`);
  return output;
};

export const buildServiceListenerQaImage = async (image: string): Promise<void> => {
  const socket = resolveLiveProviderSocket();
  if (socket === undefined) throw new Error("Set LANDO_TEST_PODMAN_SOCKET to an answering explicit socket");
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("QA fixture requires Linux amd64");
  if (!/^[a-z0-9][a-z0-9./:_-]+$/u.test(image)) throw new Error("Supply an explicit local image tag");
  const root = await mkdtemp(join(tmpdir(), "lando-listener-image-"));
  try {
    // Verify every official input before assembling or sending the build context.
    for (const input of minioQaInputs) {
      const target = join(root, input.file);
      await run([
        "curl",
        "--fail",
        "--location",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--max-time",
        "180",
        "--output",
        target,
        input.url,
      ]);
      verifyQaInput(new Uint8Array(await Bun.file(target).arrayBuffer()), input.sha256);
    }
    await Bun.write(
      join(root, "Dockerfile"),
      Bun.file(resolve(import.meta.dir, "../plugins/service-lando/test/fixtures/minio-source.Dockerfile")),
    );
    const archive = join(root, "context.tar");
    await run(["tar", "-C", root, "-cf", archive, "Dockerfile", ...minioQaInputs.map((input) => input.file)]);
    const output = await run([
      "curl",
      "--fail",
      "--silent",
      "--show-error",
      "--max-time",
      "1200",
      "--unix-socket",
      socket.socketPath,
      "--noproxy",
      "*",
      "--header",
      "Content-Type: application/x-tar",
      "--data-binary",
      `@${archive}`,
      `http://localhost/build?t=${encodeURIComponent(image)}&rm=true&forcerm=true`,
    ]);
    assertImageBuild(output);
    // A 200 build stream is not sufficient: the requested tag must have materialized.
    await run([
      "curl",
      "--fail",
      "--silent",
      "--show-error",
      "--max-time",
      "10",
      "--unix-socket",
      socket.socketPath,
      "--noproxy",
      "*",
      `http://localhost/images/${encodeURIComponent(image)}/json`,
    ]);
    console.log(`LANDO_TEST_MINIO_IMAGE=${image}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  const image = process.argv[2];
  if (image === undefined)
    throw new Error("Usage: bun scripts/build-service-listener-qa-image.ts <local-image:tag>");
  await buildServiceListenerQaImage(image);
}
