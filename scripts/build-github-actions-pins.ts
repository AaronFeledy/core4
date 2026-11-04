#!/usr/bin/env bun
import { resolve } from "node:path";
import { Effect } from "effect";
import {
  NODE_SOURCE_COMMITS,
  NODE_VERSIONS,
  RUNNER_SOURCE_COMMIT,
  RUNNER_VERSION,
  decodePinCatalog,
} from "../plugins/github-actions/src/pins-schema.ts";
import { writeFormattedOutput } from "./_codegen-output.ts";
import { GITHUB_ACTIONS_PIN_INPUTS as inputs } from "./github-actions-pin-inputs.ts";

/** Pure offline projection of reviewed upstream receipts. Never download during codegen. */
export const buildGithubActionsPins = () => {
  const artifacts = [...inputs.nodeArchives, ...inputs.runnerArchives]
    .map((receipt) => {
      const runner = receipt.file.startsWith("actions-runner-");
      const arch = receipt.file.includes("-arm64") ? "arm64" : "x64";
      const runtime = receipt.file.includes("20.20.2") ? "node20" : "node24";
      return {
        id: receipt.file,
        filename: receipt.file,
        kind: runner ? "runner-archive" : "node-archive",
        os: "linux",
        arch,
        libc: "glibc",
        version: runner ? RUNNER_VERSION : NODE_VERSIONS[runtime],
        url: receipt.url,
        checksumSourceUrl: runner
          ? `https://github.com/actions/runner/releases/tag/v${RUNNER_VERSION}`
          : `https://nodejs.org/dist/v${NODE_VERSIONS[runtime]}/SHASUMS256.txt`,
        sha256: receipt.sha256,
        sizeBytes: receipt.sizeBytes,
        archive: "tar.gz",
        noticeIds: runner ? ["runner", "node20", "node24"] : [runtime],
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const nodeRuntimes = (["node20", "node24"] as const)
    .flatMap((runtime) =>
      (["x64", "arm64"] as const).flatMap((arch) =>
        (["nodejs", "runner-externals"] as const).map((source) => {
          const version = NODE_VERSIONS[runtime];
          const artifactId =
            source === "nodejs"
              ? `node-v${version}-linux-${arch}.tar.gz`
              : `actions-runner-linux-${arch}-${RUNNER_VERSION}.tar.gz`;
          const member =
            source === "nodejs"
              ? `node-v${version}-linux-${arch}/bin/node`
              : `./externals/${runtime}/bin/node`;
          const binary = inputs.members
            .find((archive) => archive.archive === artifactId)
            ?.members.find((entry) => entry.member === member);
          return {
            id: `${runtime}-linux-${arch}-${source}`,
            runtime,
            os: "linux",
            arch,
            libc: "glibc",
            source,
            nodeVersion: version,
            sourceCommit: NODE_SOURCE_COMMITS[runtime],
            artifactId,
            member,
            binary: binary && {
              sha256: binary.sha256,
              sizeBytes: binary.sizeBytes,
              elfMachine: binary.elfMachine,
              elfClass: 64,
              endianness: "little",
            },
            ...(source === "runner-externals" ? { runnerRelativePath: `externals/${runtime}/bin/node` } : {}),
            containerCompatibility: "unverified",
          };
        }),
      ),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  const images = inputs.images
    .map((image) => ({
      ...image,
      id: `actions-runner-${RUNNER_VERSION}-linux-${image.arch}`,
      os: "linux",
      libc: "glibc",
      repository: "ghcr.io/actions/actions-runner",
      image: `ghcr.io/actions/actions-runner@${image.manifestDigest}`,
      discoveryTag: RUNNER_VERSION,
      releaseUrl: `https://github.com/actions/runner/releases/tag/v${RUNNER_VERSION}`,
      runnerSourceConformanceCommit: RUNNER_SOURCE_COMMIT,
      buildProvenance: "unverified",
      providerAcceptance: "unverified",
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return decodePinCatalog({
    schemaVersion: 1,
    runner: {
      version: RUNNER_VERSION,
      sourceCommit: RUNNER_SOURCE_COMMIT,
      sourceUrl: `https://github.com/actions/runner/tree/${RUNNER_SOURCE_COMMIT}`,
      sourceFiles: inputs.sourceFiles.map((file) => ({
        ...file,
        sourceUrl: `https://raw.githubusercontent.com/actions/runner/${RUNNER_SOURCE_COMMIT}/${file.path}`,
      })),
    },
    artifacts,
    nodeRuntimes,
    images,
    notices: inputs.notices,
  });
};

export const generateGithubActionsPins = async (): Promise<void> => {
  const catalog = await Effect.runPromise(buildGithubActionsPins());
  await writeFormattedOutput(
    resolve(import.meta.dirname, "../plugins/github-actions/src/pins.json"),
    `${JSON.stringify(catalog, null, 2)}\n`,
  );
};
if (import.meta.main) await generateGithubActionsPins();
