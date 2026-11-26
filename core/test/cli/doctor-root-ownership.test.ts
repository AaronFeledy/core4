import { describe, expect, test } from "bun:test";

import { makeLandoPaths } from "@lando/paths";
import { FilePermissionError } from "@lando/sdk/errors";
import {
  type FileStat,
  FileSystem,
  InteractionService,
  PathsService,
  PrivilegeService,
} from "@lando/sdk/services";
import { makeTestPrivilegeService } from "@lando/sdk/test";
import { type Context, Effect, Stream } from "effect";

import { rootOwnershipDoctor } from "../../src/cli/commands/doctor-root-ownership.ts";
import { CliInvocation, processInvocationDefaults } from "../../src/runtime/invocation-context.ts";
import { makeTestInteractionService } from "../../src/testing/interaction.ts";

const uid = process.getuid?.() ?? 1000;
const paths = makeLandoPaths({
  userDataRoot: "/home/dev/.local/share/lando",
  userConfRoot: "/home/dev/.config/lando",
  userCacheRoot: "/home/dev/.cache/lando",
});
const data = paths.roots.userDataRoot;

/**
 * Every path is a directory owned by the user unless listed; listed paths are root-owned, and
 * `hardLinks` are root-owned files with a second name.
 */
const fileSystem = (
  rootOwned: ReadonlySet<string>,
  unreadable: ReadonlySet<string> = new Set(),
  hardLinks: ReadonlySet<string> = new Set(),
) =>
  FileSystem.of({
    read: () => Stream.empty,
    readText: () => Effect.die("unused"),
    write: () => Effect.die("unused"),
    append: () => Effect.die("unused"),
    writeAtomic: () => Effect.die("unused"),
    exists: () => Effect.succeed(true),
    stat: () => Effect.die("unused"),
    lstat: (path) =>
      Effect.succeed<FileStat>({
        size: 0,
        mtimeMs: 0,
        isFile: hardLinks.has(path),
        isDirectory: !hardLinks.has(path),
        uid: rootOwned.has(path) || hardLinks.has(path) ? 0 : uid,
        gid: 0,
        nlink: hardLinks.has(path) ? 2 : 1,
      }),
    mkdir: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
    readDir: (path) =>
      unreadable.has(path)
        ? Effect.fail(new FilePermissionError({ message: "EACCES", path }))
        : Effect.succeed(
            path === data ? ["setup", ...[...hardLinks].map((link) => link.slice(data.length + 1))] : [],
          ),
    readFile: () => Effect.die("unused"),
    writeFile: () => Effect.die("unused"),
  });

const run = async (fs: ReturnType<typeof fileSystem>) =>
  (
    await Effect.runPromise(
      rootOwnershipDoctor((text) => text).pipe(
        Effect.provideService(PathsService, paths),
        Effect.provideService(FileSystem, fs),
      ),
    )
  ).checks;

describe.skipIf(process.platform === "win32" || uid === 0)("lando-roots doctor section", () => {
  test("fails each root-owned path with its own manual fix", async () => {
    const checks = await run(fileSystem(new Set([`${data}/setup`])));

    expect(checks.map((check) => [check.status, check.subject])).toEqual([["fail", `${data}/setup`]]);
    expect(checks[0]?.solutions[0]?.command).toBe(
      `sudo chown -R ${uid}:${process.getgid?.()} '${data}/setup'`,
    );
  });

  test("a root-owned hard link gets the command that removes it, never a chown", async () => {
    const link = `${data}/linked`;

    const checks = await run(fileSystem(new Set(), new Set(), new Set([link])));

    const finding = checks.find((check) => check.subject === link);
    expect(finding).toMatchObject({ status: "fail", recovery: "manual", context: { kind: "hard-link" } });
    expect(finding?.solutions[0]?.command).toBe(`rm -f '${link}'`);
    expect(finding?.solutions[0]?.description).toContain(
      "This file is a hard link to a file outside Lando's files, so changing its owner would change that file too.",
    );
    expect(JSON.stringify(finding)).not.toContain("chown");
  });

  test("an unreadable root is a warning, never a pass", async () => {
    const checks = await run(fileSystem(new Set(), new Set([data])));

    expect(checks.map((check) => check.status)).toEqual(["warn"]);
  });

  test("passes when every inspected entry belongs to the user", async () => {
    const checks = await run(fileSystem(new Set()));

    expect(checks.map((check) => check.status)).toEqual(["pass"]);
  });
});

describe.skipIf(process.platform === "win32" || uid === 0)("lando doctor --fix for root-owned files", () => {
  const home = "/home/dev";
  const gid = process.getgid?.() ?? uid;
  /** A Linux host where every root is safe to repair and `${data}/setup` belongs to root until fixed. */
  const host = (
    report = '{"changed":1,"skipped":[],"incomplete":[]}',
    hardLinks: ReadonlySet<string> = new Set(),
  ) => {
    const rootOwned = new Set([`${data}/setup`]);
    const repaired: string[][] = [];
    const base = fileSystem(rootOwned, new Set(), hardLinks);
    const fs = FileSystem.of({
      ...base,
      lstat: (path) =>
        base.lstat(path).pipe(
          Effect.map((stat) => ({
            ...stat,
            uid: rootOwned.has(path) || hardLinks.has(path) || path === "/" || path === "/home" ? 0 : uid,
            mode: 0o40755,
          })),
        ),
    });
    const privilege = makeTestPrivilegeService({
      elevate: (argv) =>
        Effect.sync(() => {
          repaired.push([...argv]);
          rootOwned.clear();
          return { exitCode: 0, stdout: `${report}\n`, stderr: "" };
        }),
    });
    return { fs, privilege, repaired };
  };
  const answering = (approve: boolean, interactive = true) =>
    InteractionService.of({
      ...makeTestInteractionService({ answers: { "doctor-host-changes": String(approve) } }).service,
      isInteractive: Effect.succeed(interactive),
    });
  /** The section, then its deferred fix the way doctor runs it once its progress tree is done. */
  const fix = async (
    fixture: ReturnType<typeof host>,
    interaction: Context.Service.Shape<typeof InteractionService>,
    platform = "linux",
  ) => {
    const section = await Effect.runPromise(
      rootOwnershipDoctor((text) => text, {
        fix: true,
        platform,
        account: { user: "dev", home },
        invocation: ["/usr/local/bin/lando"],
      }).pipe(
        Effect.provideService(PathsService, paths),
        Effect.provideService(FileSystem, fixture.fs),
        Effect.provideService(InteractionService, interaction),
        Effect.provideService(PrivilegeService, fixture.privilege),
        Effect.provideService(CliInvocation, processInvocationDefaults),
      ),
    );
    // The section only inspects; asking and repairing wait for doctor's fix phase.
    expect(fixture.repaired).toEqual([]);
    const [deferred, ...more] = section.fixes ?? [];
    expect(more).toEqual([]);
    return deferred === undefined ? section.checks : Effect.runPromise(deferred.run);
  };

  test("asks, gives the files back through Lando's walker, and reports recovered", async () => {
    const fixture = host();

    const checks = await fix(fixture, answering(true));

    expect(checks.map((check) => [check.status, check.context.fixOutcome])).toEqual([["pass", "recovered"]]);
    expect(fixture.repaired.map((argv) => argv.slice(0, 2))).toEqual([
      ["/usr/local/bin/lando", "__internal:repair-root-ownership"],
    ]);
    expect(fixture.repaired[0]).toContain(`${data}/setup`);
  });

  test("a run that cannot ask changes nothing and points at lando setup --yes", async () => {
    const fixture = host();

    const checks = await fix(fixture, answering(true, false));

    expect(checks.map((check) => [check.status, check.context.fixOutcome])).toEqual([
      ["fail", "skipped-manual"],
    ]);
    expect(checks[0]?.solutions[0]?.description).toContain("lando setup --yes");
    expect(fixture.repaired).toEqual([]);
  });

  test("answering no reports the fix as failed and changes nothing", async () => {
    const fixture = host();

    const checks = await fix(fixture, answering(false));

    expect(checks.map((check) => [check.status, check.context.fixOutcome])).toEqual([["fail", "failed"]]);
    expect(fixture.repaired).toEqual([]);
  });

  test("without --fix, a repairable path names lando doctor --fix and lando setup next to its command", async () => {
    const fixture = host();

    const { checks } = await Effect.runPromise(
      rootOwnershipDoctor((text) => text, {
        fix: false,
        platform: "linux",
        account: { user: "dev", home },
      }).pipe(Effect.provideService(PathsService, paths), Effect.provideService(FileSystem, fixture.fs)),
    );

    expect(checks[0]?.recovery).toBe("automatic");
    expect(checks[0]?.solutions[0]?.description).toContain(
      "Run `lando doctor --fix` or `lando setup` (Lando asks before giving these back to you)",
    );
    expect(checks[0]?.solutions[0]?.command).toBe(`sudo chown -R ${uid}:${gid} '${data}/setup'`);
  });

  test("on macOS Lando lists the command and offers no repair", async () => {
    const fixture = host();

    const checks = await fix(fixture, answering(true), "darwin");

    expect(checks.map((check) => [check.status, check.recovery, check.context.fixOutcome])).toEqual([
      ["fail", "manual", undefined],
    ]);
    expect(fixture.repaired).toEqual([]);
  });

  test("--fix offers only what Lando can give back and keeps each hard link's own command", async () => {
    const link = `${data}/linked`;
    const fixture = host(undefined, new Set([link]));

    const checks = await fix(fixture, answering(true));

    expect(fixture.repaired[0]).toContain(`${data}/setup`);
    expect(fixture.repaired[0]).not.toContain(link);
    expect(checks.find((check) => check.subject === link)?.solutions[0]?.command).toBe(`rm -f '${link}'`);
  });

  test("what the walker leaves on purpose is reported with its command, not only in the change's facts", async () => {
    const left = `${data}/setup/linked`;
    const fixture = host(`{"changed":1,"skipped":[{"path":"${left}","reason":"hard-link"}],"incomplete":[]}`);

    const checks = await fix(fixture, answering(true));

    const finding = checks.find((check) => check.subject === left);
    expect(finding).toMatchObject({ status: "fail", recovery: "manual" });
    expect(finding?.solutions[0]?.command).toBe(`rm -f '${left}'`);
  });
});
