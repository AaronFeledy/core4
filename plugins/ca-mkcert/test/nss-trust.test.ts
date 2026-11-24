import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_CERTIFICATES } from "@lando/sdk/test";
import { Effect } from "effect";

import { discoverNssDatabases } from "../src/nss-databases.ts";
import { makeNssTrust } from "../src/nss-trust.ts";
import { type FakeCertutil, makeFakeCertutil } from "./support/fake-certutil.ts";

const { rootA, rootB } = TEST_CERTIFICATES;

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "lando-nss-"));
});
afterEach(() => rm(home, { recursive: true, force: true }));

/** An executable stub named `name` in `<home>/bin`, the PATH tests hand the authority. */
const onPath = async (...names: ReadonlyArray<string>): Promise<string> => {
  const bin = join(home, "bin");
  await mkdir(bin, { recursive: true });
  for (const name of names) {
    await writeFile(join(bin, name), "#!/bin/sh\n");
    await chmod(join(bin, name), 0o755);
  }
  return bin;
};

const legacyChromium = () => join(home, ".pki", "nssdb");
const firefoxDir = () => join(home, ".mozilla", "firefox");

const names = async (env: Record<string, string>, platform = "linux") =>
  (await discoverNssDatabases(env, platform)).map(({ name, dir }) => ({ name, dir }));

describe("NSS database discovery", () => {
  test("Chromium uses the legacy database when it exists, else the XDG one", async () => {
    const xdg = join(home, "xdg");
    expect(await names({ HOME: home, XDG_DATA_HOME: xdg })).toEqual([]);
    await mkdir(join(xdg, "pki", "nssdb"), { recursive: true });
    expect(await names({ HOME: home, XDG_DATA_HOME: xdg })).toEqual([
      { name: "Chrome and Chromium", dir: join(xdg, "pki", "nssdb") },
    ]);
    await mkdir(legacyChromium(), { recursive: true });
    expect(await names({ HOME: home, XDG_DATA_HOME: xdg })).toEqual([
      { name: "Chrome and Chromium", dir: legacyChromium() },
    ]);
  });

  test("Chromium falls back to ~/.local/share when XDG_DATA_HOME is unset", async () => {
    await mkdir(join(home, ".local", "share", "pki", "nssdb"), { recursive: true });
    expect(await names({ HOME: home })).toEqual([
      { name: "Chrome and Chromium", dir: join(home, ".local", "share", "pki", "nssdb") },
    ]);
  });

  test("Firefox counts registered profiles with a cert9.db only", async () => {
    // Given: a relative and an absolute registered profile with cert9.db, a registered cert8-only
    // profile, and an unregistered profile directory with cert9.db
    const absolute = join(home, "elsewhere");
    for (const dir of ["abc.default-release", "old.legacy", "zzz.unregistered"]) {
      await mkdir(join(firefoxDir(), dir), { recursive: true });
    }
    await mkdir(absolute, { recursive: true });
    await writeFile(join(firefoxDir(), "abc.default-release", "cert9.db"), "");
    await writeFile(join(firefoxDir(), "old.legacy", "cert8.db"), "");
    await writeFile(join(firefoxDir(), "zzz.unregistered", "cert9.db"), "");
    await writeFile(join(absolute, "cert9.db"), "");
    await writeFile(
      join(firefoxDir(), "profiles.ini"),
      [
        "[Install4F96D1932A9F858E]",
        "Default=abc.default-release",
        "[Profile0]",
        "Name=default-release",
        "IsRelative=1",
        "Path=abc.default-release",
        "[Profile1]",
        "Name=legacy",
        "IsRelative=1",
        "Path=old.legacy",
        "[Profile2]",
        "Name=work",
        "IsRelative=0",
        `Path=${absolute}`,
        "[Profile3]",
        "Name=duplicate",
        "IsRelative=1",
        "Path=abc.default-release",
        "[General]",
        "Version=2",
      ].join("\n"),
    );
    // Then
    expect(await names({ HOME: home })).toEqual([
      { name: "Firefox (default-release)", dir: join(firefoxDir(), "abc.default-release") },
      { name: "Firefox (work)", dir: absolute },
    ]);
  });

  test("Firefox ignores profiles whose real directory leaves the home or enters a Snap sandbox", async () => {
    // Given: an absolute profile outside HOME and a relative one that symlinks into ~/snap, both with cert9.db
    const outside = await mkdtemp(join(tmpdir(), "lando-nss-outside-"));
    const snapProfile = join(home, "snap", "firefox", "common", ".mozilla", "firefox", "s.default");
    try {
      for (const dir of [outside, snapProfile]) {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "cert9.db"), "");
      }
      await mkdir(firefoxDir(), { recursive: true });
      await symlink(snapProfile, join(firefoxDir(), "linked.default"));
      await writeFile(
        join(firefoxDir(), "profiles.ini"),
        [
          "[Profile0]",
          "Name=outside",
          "IsRelative=0",
          `Path=${outside}`,
          "[Profile1]",
          "Name=snap",
          "IsRelative=1",
          "Path=linked.default",
        ].join("\n"),
      );
      // Then
      expect(await names({ HOME: home })).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("finds nothing without a home directory or off Linux", async () => {
    await mkdir(legacyChromium(), { recursive: true });
    expect(await names({})).toEqual([]);
    expect(await names({ HOME: home }, "darwin")).toEqual([]);
    expect(await names({ HOME: home }, "win32")).toEqual([]);
  });
});

const nss = (certutil: FakeCertutil, path: string) =>
  makeNssTrust({ processRunner: certutil.service, env: { HOME: home, PATH: path }, platform: "linux" });

const inspect = (certutil: FakeCertutil, path: string) =>
  Effect.runPromise(nss(certutil, path).inspect(rootA));

const CHROMIUM = { id: "nss", name: "Chrome and Chromium" };

describe("NSS trust", () => {
  test.each([
    {
      managers: ["apt", "dnf"],
      remediation: "Run `sudo apt install libnss3-tools`, then run `lando setup`.",
    },
    { managers: ["dnf", "yum"], remediation: "Run `sudo dnf install nss-tools`, then run `lando setup`." },
    { managers: ["yum"], remediation: "Run `sudo yum install nss-tools`, then run `lando setup`." },
    {
      managers: ["zypper"],
      remediation: "Run `sudo zypper install mozilla-nss-tools`, then run `lando setup`.",
    },
    { managers: ["pacman"], remediation: "Run `sudo pacman -S nss`, then run `lando setup`." },
    { managers: [], remediation: "Install NSS's certutil, then run `lando setup`." },
  ])(
    "without certutil each database is unknown; with $managers the remediation names the package",
    async ({ managers, remediation }) => {
      await mkdir(legacyChromium(), { recursive: true });
      const certutil = makeFakeCertutil();
      const rows = await inspect(certutil, await onPath(...managers));
      expect(rows.map(({ status }) => status)).toEqual([
        {
          ...CHROMIUM,
          location: legacyChromium(),
          state: "unknown",
          reason: "tool-missing",
          detail: "NSS's certutil is not installed, so Lando cannot check or update this browser database.",
          remediation,
        },
      ]);
      expect(certutil.calls()).toEqual([]);
    },
  );

  test("a TLS-trusted root under a foreign nickname counts as trusted", async () => {
    const certutil = makeFakeCertutil({
      [legacyChromium()]: [
        { nickname: "Other Root", trust: "C,,", pem: rootB },
        { nickname: "My Dev Root", trust: "CT,c,", pem: rootA },
      ],
    });
    await mkdir(legacyChromium(), { recursive: true });
    const rows = await inspect(certutil, await onPath("certutil"));
    expect(rows.map(({ status }) => status)).toEqual([
      { ...CHROMIUM, location: legacyChromium(), state: "trusted" },
    ]);
  });

  test("a root present without TLS trust is reported and never overridden", async () => {
    const certutil = makeFakeCertutil({
      [legacyChromium()]: [{ nickname: "mkcert development CA 4096", trust: ",C,", pem: rootA }],
    });
    await mkdir(legacyChromium(), { recursive: true });
    const trust = nss(certutil, await onPath("certutil"));
    const before = await Effect.runPromise(trust.inspect(rootA));
    const after = await Effect.runPromise(trust.install(home, rootA, before));
    expect(after.map(({ status }) => status)).toEqual([
      {
        ...CHROMIUM,
        location: legacyChromium(),
        state: "untrusted",
        reason: "not-trusted-for-tls",
        detail: "The database holds the local CA but does not trust it to identify websites.",
        remediation:
          "In Chrome or Chromium's certificate settings, trust the local CA to identify websites, then run `lando doctor`.",
      },
    ]);
    expect(certutil.calls().filter(({ args }) => args[0] === "-A")).toEqual([]);
  });

  test("install adds the root under mkcert's decimal-serial nickname and re-inspects that database", async () => {
    // Given: a Chromium database without the root and a Firefox profile that already trusts it
    const profile = join(firefoxDir(), "p.default");
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, "cert9.db"), "");
    await writeFile(
      join(firefoxDir(), "profiles.ini"),
      "[Profile0]\nName=default\nIsRelative=1\nPath=p.default\n",
    );
    await mkdir(legacyChromium(), { recursive: true });
    await writeFile(join(home, "rootCA.pem"), rootA);
    const certutil = makeFakeCertutil({
      [legacyChromium()]: [{ nickname: "Other Root", trust: "C,,", pem: rootB }],
      [profile]: [{ nickname: "Lando", trust: "C,,", pem: rootA }],
    });
    const path = await onPath("certutil");
    const trust = nss(certutil, path);
    const before = await Effect.runPromise(trust.inspect(rootA));
    expect(before.map(({ status }) => status.reason)).toEqual(["missing", undefined]);
    const listingsBefore = certutil.calls().length;
    // When
    const after = await Effect.runPromise(trust.install(home, rootA, before));
    // Then
    const writes = certutil.calls().slice(listingsBefore);
    expect(writes[0]).toEqual({
      cmd: join(path, "certutil"),
      args: [
        "-A",
        "-d",
        `sql:${legacyChromium()}`,
        "-t",
        "C,,",
        "-n",
        "mkcert development CA 4096",
        "-i",
        join(home, "rootCA.pem"),
      ],
    });
    // Only the database it wrote is read again.
    expect(writes.slice(1).every(({ args }) => args.includes(`sql:${legacyChromium()}`))).toBe(true);
    expect(after.map(({ status }) => status)).toEqual([
      {
        ...CHROMIUM,
        location: legacyChromium(),
        state: "trusted",
        detail: "Restart Chrome or Chromium to use it.",
      },
      { id: "nss", name: "Firefox (default)", location: profile, state: "trusted" },
    ]);
  });

  test("a failed write leaves the database untrusted with certutil's error", async () => {
    await mkdir(legacyChromium(), { recursive: true });
    const certutil = makeFakeCertutil(
      { [legacyChromium()]: [] },
      { addError: "certutil: could not add certificate: SEC_ERROR_LOCKED_DATABASE" },
    );
    const trust = nss(certutil, await onPath("certutil"));
    const after = await Effect.runPromise(
      trust.install(home, rootA, await Effect.runPromise(trust.inspect(rootA))),
    );
    expect(after.map(({ status }) => status)).toEqual([
      {
        ...CHROMIUM,
        location: legacyChromium(),
        state: "untrusted",
        reason: "install-failed",
        detail: "certutil: could not add certificate: SEC_ERROR_LOCKED_DATABASE",
        remediation:
          "Close Chrome or Chromium if it reports the database is locked, then run `lando setup` again.",
      },
    ]);
  });

  test("a database too large to search fully is unknown and never written", async () => {
    // Given: 21 TLS-trusted foreign roots listed before the local CA, one past the search cap
    await mkdir(legacyChromium(), { recursive: true });
    await writeFile(join(home, "rootCA.pem"), rootA);
    const certutil = makeFakeCertutil({
      [legacyChromium()]: [
        ...Array.from({ length: 21 }, (_, index) => ({
          nickname: `Other ${index}`,
          trust: "C,,",
          pem: rootB,
        })),
        { nickname: "Lando", trust: "C,,", pem: rootA },
      ],
    });
    const trust = nss(certutil, await onPath("certutil"));
    // When
    const after = await Effect.runPromise(
      trust.install(home, rootA, await Effect.runPromise(trust.inspect(rootA))),
    );
    // Then
    expect(after.map(({ status }) => status)).toEqual([
      {
        ...CHROMIUM,
        location: legacyChromium(),
        state: "unknown",
        reason: "inspection-incomplete",
        detail:
          "The database holds 22 certificates; Lando checked 20 and did not find the local CA, leaving 2 unchecked.",
        remediation:
          "Check whether Chrome or Chromium's certificate settings trust the local CA, then run `lando doctor`.",
      },
    ]);
    expect(certutil.calls().filter(({ args }) => args[0] === "-A")).toEqual([]);
  });

  test("a database certutil cannot read is unknown", async () => {
    await mkdir(legacyChromium(), { recursive: true });
    const certutil = makeFakeCertutil({});
    const [row] = await inspect(certutil, await onPath("certutil"));
    expect(row?.status).toMatchObject({ state: "unknown", reason: "inspection-failed" });
    expect(row?.status.detail).toContain("SEC_ERROR_BAD_DATABASE");
  });
});
