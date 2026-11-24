import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostPlatform, HostUninstallStep } from "@lando/sdk/schema";
import { TEST_CERTIFICATES } from "@lando/sdk/test";
import { Effect } from "effect";

import {
  LOCAL_CA_MAINTAINER_ID,
  type LocalCaHostAccess,
  makeLocalCaHostMaintainer,
  mkcertCaRoot,
} from "../src/uninstall-trust.ts";

// rootA's serial is 0x1000: mkcert names its entries after the decimal form.
const NICKNAME = "mkcert development CA 4096";
const SHA1 = "6BDF0095A4C98D80C015A3E24146B22DFF0DBBCA";
const SHA256 =
  "D4:AB:14:F1:74:9F:27:BC:35:6B:71:25:D2:82:A1:DA:64:33:09:56:77:54:8F:3C:F9:05:3E:C4:42:FA:C7:40";

describe("mkcert CAROOT resolution", () => {
  test.each<[string, HostPlatform, Record<string, string>, string | undefined]>([
    ["CAROOT wins everywhere", "win32", { CAROOT: "/ca", LOCALAPPDATA: "C:\\L" }, "/ca"],
    ["empty CAROOT is unset", "linux", { CAROOT: "", HOME: "/h" }, "/h/.local/share/mkcert"],
    [
      "windows uses LOCALAPPDATA, never XDG",
      "win32",
      { LOCALAPPDATA: "C:\\L", XDG_DATA_HOME: "/x" },
      "C:\\L\\mkcert",
    ],
    ["windows without LOCALAPPDATA has none", "win32", { HOME: "/h" }, undefined],
    ["XDG_DATA_HOME beats the darwin default", "darwin", { XDG_DATA_HOME: "/x", HOME: "/h" }, "/x/mkcert"],
    ["darwin default", "darwin", { HOME: "/h" }, "/h/Library/Application Support/mkcert"],
    ["linux default", "linux", { HOME: "/h" }, "/h/.local/share/mkcert"],
    ["wsl resolves like linux", "wsl", { XDG_DATA_HOME: "/x" }, "/x/mkcert"],
    ["no HOME has none", "linux", {}, undefined],
  ])("%s", (_name, platform, env, expected) => {
    expect(mkcertCaRoot(platform, env)).toBe(expected);
  });
});

describe("local CA uninstall step", () => {
  let dir: string;
  let caroot: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lando-local-ca-uninstall-"));
    caroot = join(dir, "mkcert");
    await mkdir(caroot);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const plan = async (platform: HostPlatform, access: Partial<LocalCaHostAccess>) => {
    const maintainer = makeLocalCaHostMaintainer({ exists: () => false, listDirs: () => [], ...access });
    expect(maintainer.id).toBe(LOCAL_CA_MAINTAINER_ID);
    const steps = await Effect.runPromise(
      maintainer.uninstall?.plan({ platform, userDataRoot: dir }) ?? Effect.die("no uninstall"),
    );
    expect(steps).toHaveLength(1);
    return steps[0] as HostUninstallStep;
  };

  test("is skipped when CAROOT holds no root", async () => {
    const step = await plan("linux", { env: { CAROOT: caroot } });
    expect(step).toMatchObject({ id: "trust", status: "skipped", target: caroot });
    expect(step.preserveOnKeepData).toBeUndefined();
  });

  test("linux names the anchor files, NSS databases and Homebrew bundles that exist", async () => {
    await writeFile(join(caroot, "rootCA.pem"), TEST_CERTIFICATES.rootA);
    const prefix = join(dir, "brew");
    await mkdir(join(prefix, "opt", "ca-certificates"), { recursive: true });
    const home = "/home/u";
    const firefox = `${home}/.mozilla/firefox`;
    const present = new Set([
      `/usr/local/share/ca-certificates/${NICKNAME.replaceAll(" ", "_")}.crt`,
      `${home}/.pki/nssdb/cert9.db`,
      `${firefox}/abc.default/cert9.db`,
    ]);
    const step = await plan("linux", {
      env: { CAROOT: caroot, HOME: home, HOMEBREW_PREFIX: prefix, PATH: "" },
      exists: (path) => present.has(path),
      listDirs: (path) => (path === firefox ? ["abc.default", "no-db"] : []),
    });

    expect(step).toMatchObject({
      status: "manual",
      target: caroot,
      preserveOnKeepData: true,
      destructive: false,
    });
    expect(step.detail).toContain(SHA256);
    expect(step.detail).toContain(
      "`sudo rm -f /usr/local/share/ca-certificates/mkcert_development_CA_4096.crt && sudo update-ca-certificates`",
    );
    expect(step.detail).not.toContain("/etc/pki/ca-trust/source/anchors");
    expect(step.detail).toContain(`\`certutil -D -d sql:${home}/.pki/nssdb -n '${NICKNAME}'\``);
    expect(step.detail).toContain(`\`certutil -D -d sql:${firefox}/abc.default -n '${NICKNAME}'\``);
    expect(step.detail).not.toContain("no-db");
    expect(step.detail).toContain(`\`${prefix}/bin/brew postinstall ca-certificates\``);
    expect(step.detail).not.toContain("certutil.exe");
    expect(step.detail).toContain(`delete ${caroot},`);
    expect(step.detail).not.toContain("\n");
  });

  test("wsl adds the Windows store removal", async () => {
    await writeFile(join(caroot, "rootCA.pem"), TEST_CERTIFICATES.rootA);
    const step = await plan("wsl", { env: { CAROOT: caroot, PATH: "" } });
    expect(step.detail).toContain(`\`certutil.exe -user -delstore Root ${SHA1}\``);
  });

  test("darwin removes the trust setting and the System keychain entry", async () => {
    const support = join(dir, "Application Support", "mkcert");
    await mkdir(support, { recursive: true });
    await writeFile(join(support, "rootCA.pem"), TEST_CERTIFICATES.rootA);
    const step = await plan("darwin", { env: { CAROOT: support, PATH: "" } });
    expect(step.detail).toContain(`\`sudo security remove-trusted-cert -d '${support}/rootCA.pem'\``);
    expect(step.detail).toContain(
      `\`sudo security delete-certificate -Z ${SHA1} /Library/Keychains/System.keychain\``,
    );
  });

  test("windows deletes from the user Root store by SHA-1", async () => {
    await writeFile(join(caroot, "rootCA.pem"), TEST_CERTIFICATES.rootA);
    const step = await plan("win32", { env: { CAROOT: caroot } });
    expect(step.detail).toContain(`\`certutil -user -delstore Root ${SHA1}\``);
    expect(step.detail).not.toContain("sudo");
  });

  test("execute reports the planned manual detail", async () => {
    await writeFile(join(caroot, "rootCA.pem"), TEST_CERTIFICATES.rootA);
    const maintainer = makeLocalCaHostMaintainer({ env: { CAROOT: caroot } });
    const step = await plan("win32", { env: { CAROOT: caroot } });
    const outcome = await Effect.runPromise(
      maintainer.uninstall?.execute({ platform: "win32", userDataRoot: dir, step }) ??
        Effect.die("no uninstall"),
    );
    expect(outcome).toEqual({ outcome: "manual", detail: step.detail });
  });
});
