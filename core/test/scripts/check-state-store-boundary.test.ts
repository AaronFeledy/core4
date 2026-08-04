import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { describe, expect, test } from "bun:test";

import { stateStoreRule } from "../../../scripts/boundary/rules/state-store.ts";
import { checkStateStoreBoundary } from "../../../scripts/check-state-store-boundary.ts";

const ATOMIC_WRITE_RENAME = `
await writeFile("state.tmp-1", "{}");
await rename("state.tmp-1", "state.json");
`;

const LOCKFILE = `
const lockPath = "state.lock";
await unlink(lockPath);
`;

const VERSION_ENVELOPE = `
const encoded = JSON.stringify({ version: 1, data: {} });
`;

const ALL_SIGNALS = `${ATOMIC_WRITE_RENAME}\n${LOCKFILE}\n${VERSION_ENVELOPE}`;

const SINGLE_SIGNAL_CASES = [
  { name: "atomic-write-rename", content: ATOMIC_WRITE_RENAME },
  { name: "lockfile", content: LOCKFILE },
  { name: "version-envelope", content: VERSION_ENVELOPE },
] as const;

const TWO_SIGNAL_CASES = [
  {
    name: "atomic-write-rename and lockfile",
    content: `${ATOMIC_WRITE_RENAME}\n${LOCKFILE}`,
  },
  {
    name: "atomic-write-rename and version-envelope",
    content: `${ATOMIC_WRITE_RENAME}\n${VERSION_ENVELOPE}`,
  },
  {
    name: "lockfile and version-envelope",
    content: `${LOCKFILE}\n${VERSION_ENVELOPE}`,
  },
] as const;

const FORMER_CARVE_OUTS = [
  "core/src/cache/atomic.ts",
  "core/src/landofile/includes.ts",
  "core/src/scratch-app/registry.ts",
  "core/src/state-store/atomic.ts",
  "core/src/state/service.ts",
] as const;

interface FixtureFile {
  readonly path: string;
  readonly content: string;
}

const makeFixtureRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "lando-state-store-boundary-"));

const write = async (root: string, path: string, content: string): Promise<void> => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content, "utf8");
};

const checkFixture = async (files: ReadonlyArray<FixtureFile>) => {
  const root = await makeFixtureRoot();
  try {
    for (const file of files) await write(root, file.path, file.content);

    const result = await checkStateStoreBoundary({ root });

    return {
      ok: result.ok,
      offenders: result.offenders.map((offender) => ({
        file: relative(root, offender.file).replaceAll("\\", "/"),
        signals: offender.signals,
      })),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe("state-store boundary lint gate", () => {
  test("preserves the stable failure headline", () => {
    expect(stateStoreRule.failureHeadline).toBe(
      "State-store boundary check failed. Durable atomic-write + lockfile + version-envelope logic must route through @lando/state-store.",
    );
  });

  for (const signalCase of SINGLE_SIGNAL_CASES) {
    test(`passes when a core source file has only the ${signalCase.name} signal`, async () => {
      expect(
        await checkFixture([{ path: "core/src/example/single.ts", content: signalCase.content }]),
      ).toEqual({ ok: true, offenders: [] });
    });
  }

  for (const signalCase of TWO_SIGNAL_CASES) {
    test(`passes when a core source file has only ${signalCase.name} signals`, async () => {
      expect(await checkFixture([{ path: "core/src/example/pair.ts", content: signalCase.content }])).toEqual(
        { ok: true, offenders: [] },
      );
    });
  }

  test("reports a core source file containing all three signals", async () => {
    expect(await checkFixture([{ path: "core/src/example/durable-state.ts", content: ALL_SIGNALS }])).toEqual(
      {
        ok: false,
        offenders: [
          {
            file: "core/src/example/durable-state.ts",
            signals: ["atomic-write-rename", "lockfile", "version-envelope"],
          },
        ],
      },
    );
  });

  test("reports a plugin source file containing all three signals", async () => {
    expect(
      await checkFixture([{ path: "plugins/example/src/durable-state.ts", content: ALL_SIGNALS }]),
    ).toEqual({
      ok: false,
      offenders: [
        {
          file: "plugins/example/src/durable-state.ts",
          signals: ["atomic-write-rename", "lockfile", "version-envelope"],
        },
      ],
    });
  });

  for (const path of FORMER_CARVE_OUTS) {
    test(`reports hand-rolled durable state in the former carve-out ${path}`, async () => {
      // Given a core source path that was exempt before StateStore became a package seam.
      // When it combines all three durable-state mechanics, then the residual gate reports it.
      expect(await checkFixture([{ path, content: ALL_SIGNALS }])).toEqual({
        ok: false,
        offenders: [
          {
            file: path,
            signals: ["atomic-write-rename", "lockfile", "version-envelope"],
          },
        ],
      });
    });
  }

  test("ignores the canonical StateStore package implementation", async () => {
    // Given the implementation package that owns durable-state mechanics.
    // When the residual core/plugin gate runs, then package internals stay outside its scope.
    expect(await checkFixture([{ path: "state-store/src/service.ts", content: ALL_SIGNALS }])).toEqual({
      ok: true,
      offenders: [],
    });
  });

  test("passes when all three signals occur in a test file", async () => {
    expect(
      await checkFixture([{ path: "core/src/example/durable-state.test.ts", content: ALL_SIGNALS }]),
    ).toEqual({ ok: true, offenders: [] });
  });

  test("reports a temp write path that is statically folded through a const", async () => {
    // Given a temp marker assembled from constant string fragments.
    const content = `
const stagedPath = "state." + "tmp-1";
await writeFile(stagedPath, "{}");
await rename(stagedPath, "state.json");
${LOCKFILE}
${VERSION_ENVELOPE}
`;

    // When the boundary gate scans the source, then all three signals are reported.
    expect(await checkFixture([{ path: "core/src/example/const-temp.ts", content }])).toEqual({
      ok: false,
      offenders: [
        {
          file: "core/src/example/const-temp.ts",
          signals: ["atomic-write-rename", "lockfile", "version-envelope"],
        },
      ],
    });
  });

  test("reports rename through an aliased destructured fs import", async () => {
    // Given rename imported under a different local name.
    const content = `
import { rename as move, writeFile } from "node:fs/promises";
await writeFile("state.tmp-1", "{}");
await move("state.tmp-1", "state.json");
${LOCKFILE}
${VERSION_ENVELOPE}
`;

    // When the boundary gate scans the source, then the aliased rename completes signal A.
    expect(await checkFixture([{ path: "plugins/example/src/aliased-rename.ts", content }])).toEqual({
      ok: false,
      offenders: [
        {
          file: "plugins/example/src/aliased-rename.ts",
          signals: ["atomic-write-rename", "lockfile", "version-envelope"],
        },
      ],
    });
  });

  test("reports a version envelope unwrapped from a local const", async () => {
    // Given JSON.stringify receives an aliased object envelope.
    const content = `
const version = 1;
const data = {};
const envelope = { version: version, data: data };
JSON.stringify(envelope);
${ATOMIC_WRITE_RENAME}
${LOCKFILE}
`;

    // When the boundary gate scans the source, then the aliased envelope completes signal C.
    expect(await checkFixture([{ path: "core/src/example/aliased-envelope.ts", content }])).toEqual({
      ok: false,
      offenders: [
        {
          file: "core/src/example/aliased-envelope.ts",
          signals: ["atomic-write-rename", "lockfile", "version-envelope"],
        },
      ],
    });
  });

  test("passes when aliased forms provide only two of the three signals", async () => {
    // Given each file contains a different pair of alias-aware signals.
    const aliasedAtomic = `
import { rename as move, writeFile as persist } from "node:fs/promises";
const stagedPath = "state." + "tmp-1";
await persist(stagedPath, "{}");
await move(stagedPath, "state.json");
`;
    const aliasedEnvelope = `
const envelope = { version: 1, data: {} };
JSON.stringify(envelope);
`;
    const aliasedLock = `
import { open as acquire } from "node:fs/promises";
await acquire("state.lock", "wx");
`;

    // When the boundary gate scans all pairs, then none crosses the three-signal threshold.
    expect(
      await checkFixture([
        { path: "core/src/example/atomic-lock.ts", content: aliasedAtomic + aliasedLock },
        { path: "core/src/example/atomic-envelope.ts", content: aliasedAtomic + aliasedEnvelope },
        { path: "core/src/example/lock-envelope.ts", content: aliasedLock + aliasedEnvelope },
      ]),
    ).toEqual({ ok: true, offenders: [] });
  });
});
