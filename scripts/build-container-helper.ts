#!/usr/bin/env bun
/**
 * Builds the static in-container helper for linux-x64 and linux-arm64 with Lando
 * itself: the source-mode CLI starts the `builder` service from
 * `core/container-helper/.lando.yml` (a pinned golang image) and runs `go build`
 * there, so no Go toolchain is needed on the host. `--test` also runs `go vet`
 * and `go test` first.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  CONTAINER_HELPER_ARCHES,
  CONTAINER_HELPER_FILE,
  containerHelperGoArch,
} from "@lando/container-runtime/container-helper";

import { containerHelperNotices } from "../core/src/container-helper/notices.ts";
import {
  CONTAINER_HELPER_SOURCE_DIGEST_PATH,
  CONTAINER_HELPER_SOURCE_ROOT,
  containerHelperLinkerFlags,
  containerHelperSourceDigest,
} from "../core/src/container-helper/source.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const LANDO = [process.execPath, resolve(REPO_ROOT, "core/bin/lando.ts")];

export const containerHelperBuildCommands = (options: {
  readonly test: boolean;
  readonly linkerFlags: string;
}): ReadonlyArray<ReadonlyArray<string>> => {
  const inBuilder = (...argv: ReadonlyArray<string>) => ["exec", "builder", "--cwd", "/app", "--", ...argv];
  return [
    ["start"],
    inBuilder(
      "sh",
      "-ec",
      'rm -rf dist/licenses/go; mkdir -p dist/licenses/go; goroot=$(go env GOROOT); cp "$goroot/LICENSE" dist/licenses/go/LICENSE; if [ -f "$goroot/PATENTS" ]; then cp "$goroot/PATENTS" dist/licenses/go/PATENTS; printf \'["licenses/go/LICENSE","licenses/go/PATENTS"]\\n\' > dist/licenses/go/files.json; else printf \'["licenses/go/LICENSE"]\\n\' > dist/licenses/go/files.json; fi',
    ),
    ...(options.test ? [inBuilder("go", "vet", "./..."), inBuilder("go", "test", "./...")] : []),
    ...CONTAINER_HELPER_ARCHES.map((arch) =>
      inBuilder(
        "env",
        `GOARCH=${containerHelperGoArch(arch)}`,
        "GOOS=linux",
        "go",
        "build",
        "-trimpath",
        "-buildvcs=false",
        `-ldflags=${options.linkerFlags}`,
        "-o",
        `dist/linux-${arch}/${CONTAINER_HELPER_FILE}`,
        ".",
      ),
    ),
  ];
};

const run = async (argv: ReadonlyArray<string>): Promise<void> => {
  const proc = Bun.spawn([...LANDO, ...argv], {
    cwd: CONTAINER_HELPER_SOURCE_ROOT,
    env: { ...process.env, LANDO_RENDERER: process.env.LANDO_RENDERER ?? "plain" },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`lando ${argv.join(" ")} exited ${exitCode}`);
};

if (import.meta.main) {
  const test = process.argv.includes("--test");
  const digest = await containerHelperSourceDigest();
  await rm(CONTAINER_HELPER_SOURCE_DIGEST_PATH, { force: true });
  for (const argv of containerHelperBuildCommands({ test, linkerFlags: containerHelperLinkerFlags() }))
    await run(argv);
  await containerHelperNotices(resolve(CONTAINER_HELPER_SOURCE_ROOT, "dist"));
  await mkdir(dirname(CONTAINER_HELPER_SOURCE_DIGEST_PATH), { recursive: true });
  await writeFile(CONTAINER_HELPER_SOURCE_DIGEST_PATH, `${digest}\n`);
}
