import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import {
  SOCKET_PROXY_POLKIT_PATH,
  SOCKET_PROXY_UNIT_PATHS,
  socketProxyContentDigest,
  socketProxyPolkitHeader,
  socketProxyUnitHeader,
} from "../src/socket-proxy-helper.ts";
import { makeSocketProxyHostMaintainer } from "../src/socket-proxy-host-maintainer.ts";
import { buildInstallScript, buildUninstallScript } from "../src/socket-proxy-units.ts";

const sandbox = () => {
  const root = mkdtempSync(join(tmpdir(), "lando-helper-uninstall-"));
  const userDataRoot = join(root, "data");
  mkdirSync(userDataRoot);
  const unitPaths = SOCKET_PROXY_UNIT_PATHS.map((path) => join(root, path.slice(path.lastIndexOf("/") + 1)));
  const polkitPath = join(root, "10-lando-proxy.rules");
  const maintainer = makeSocketProxyHostMaintainer({ unitPaths, polkitPath });
  return { root, userDataRoot, unitPaths, polkitPath, maintainer };
};

const populate = (fixture: ReturnType<typeof sandbox>, owner: string) => {
  const unit = `${socketProxyUnitHeader(owner)}\n[Unit]\n`;
  const polkit = `${socketProxyPolkitHeader(owner)}\npolkit.addRule(function () {});\n`;
  for (const path of fixture.unitPaths) writeFileSync(path, unit);
  writeFileSync(fixture.polkitPath, polkit);
};

test.each([
  { name: "absent", owner: undefined, status: "skipped" },
  { name: "owned", owner: "self", status: "owned" },
  { name: "other-root", owner: "other", status: "user-owned" },
  { name: "missing-root", owner: "/lando/gone", status: "manual" },
  { name: "malformed", owner: "malformed", status: "manual" },
])("plans $name ownership through the contributed maintainer", async ({ owner, status }) => {
  const fixture = sandbox();
  try {
    const other = join(fixture.root, "other");
    mkdirSync(other);
    if (owner !== undefined) {
      populate(
        fixture,
        owner === "self" ? realpathSync(fixture.userDataRoot) : owner === "other" ? other : owner,
      );
      if (owner === "malformed") {
        for (const path of fixture.unitPaths)
          writeFileSync(path, "# lando-proxy-socket-helper\n# lando-data-root: broken\n");
      }
    }
    const steps = await Effect.runPromise(
      fixture.maintainer.uninstall.plan({ platform: "linux", userDataRoot: fixture.userDataRoot }),
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ id: "socket-proxy-helper", status, preserveOnKeepData: true });
    if (status === "manual") expect(steps[0]?.detail).toContain("sudo systemctl");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("omits the uninstall step outside Linux and WSL", async () => {
  const maintainer = makeSocketProxyHostMaintainer({
    exists: () => {
      throw new Error("unexpected IO");
    },
  });
  expect(
    await Effect.runPromise(maintainer.uninstall.plan({ platform: "darwin", userDataRoot: "/unused" })),
  ).toEqual([]);
});

test.each(["owned", "foreign"])(
  "preserves %s artifacts when privileged removal is unavailable or forbidden",
  async (kind) => {
    const fixture = sandbox();
    try {
      const other = join(fixture.root, "other");
      mkdirSync(other);
      populate(fixture, kind === "owned" ? fixture.userDataRoot : other);
      const steps = await Effect.runPromise(
        fixture.maintainer.uninstall.plan({ platform: "linux", userDataRoot: fixture.userDataRoot }),
      );
      const step = steps[0];
      if (step === undefined) throw new Error("expected a helper step");
      let elevated = 0;
      const outcome = await Effect.runPromise(
        fixture.maintainer.uninstall.execute({
          platform: "linux",
          userDataRoot: fixture.userDataRoot,
          step,
          ...(kind === "foreign"
            ? {
                elevate: () =>
                  Effect.sync(() => {
                    elevated++;
                    return { exitCode: 0, stdout: "", stderr: "" };
                  }),
              }
            : {}),
        }),
      );
      expect(outcome.outcome).toBe("manual");
      expect(elevated).toBe(0);
      expect([...fixture.unitPaths, fixture.polkitPath].every(existsSync)).toBe(true);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  },
);

describe.each(["install", "uninstall"] as const)("%s privileged script", (operation) => {
  test.each([
    { fault: "none", exit: 0 },
    { fault: "missing-flock", exit: 4 },
    { fault: "symlink", exit: 5 },
    { fault: "digest-change", exit: 3 },
    { fault: "appeared", exit: 3 },
  ])("refuses unsafe $fault prior state before systemctl or mutation", ({ fault, exit }) => {
    const fixture = sandbox();
    try {
      populate(fixture, fixture.userDataRoot);
      const paths = [...fixture.unitPaths, fixture.polkitPath];
      const priorDigests: Record<string, string | null> = {};
      paths.forEach((path, index) => {
        const key =
          operation === "install" ? [...SOCKET_PROXY_UNIT_PATHS, SOCKET_PROXY_POLKIT_PATH][index] : path;
        if (key === undefined) throw new Error("missing artifact key");
        priorDigests[key] = socketProxyContentDigest(readFileSync(path, "utf8"));
      });
      const first = fixture.unitPaths[0];
      if (first === undefined) throw new Error("missing socket path");
      if (fault === "symlink") {
        const real = join(fixture.root, "real.socket");
        writeFileSync(real, readFileSync(first));
        rmSync(first);
        symlinkSync(real, first);
      }
      if (fault === "digest-change") writeFileSync(first, `${readFileSync(first, "utf8")}# changed\n`);
      if (fault === "appeared")
        priorDigests[operation === "install" ? SOCKET_PROXY_UNIT_PATHS[0] : first] = null;
      const bin = join(fixture.root, "bin");
      mkdirSync(bin);
      const log = join(fixture.root, "systemctl.log");
      writeFileSync(join(bin, "systemctl"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SYSTEMCTL_LOG"\n', {
        mode: 0o755,
      });
      for (const name of ["chown", "chmod"])
        writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const script =
        operation === "install"
          ? buildInstallScript({
              user: "lando",
              userDataRoot: fixture.userDataRoot,
              binary: "/fake/proxyd",
              serviceType: "notify",
              httpTarget: 8080,
              httpsTarget: 8443,
              priorDigests,
            })
          : buildUninstallScript({
              unitPaths: fixture.unitPaths,
              polkitPath: fixture.polkitPath,
              canonicalUserDataRoot: fixture.userDataRoot,
              priorDigests,
            });
      const safeScript = script
        .replaceAll("/run/lock/lando-proxy-helper.lock", join(fixture.root, "helper.lock"))
        .replaceAll("/etc/systemd/system", fixture.root)
        .replaceAll("/etc/polkit-1/rules.d", fixture.root);
      const result = Bun.spawnSync(["/bin/sh", "-c", safeScript], {
        env: {
          ...process.env,
          PATH: fault === "missing-flock" ? bin : `${bin}:/usr/bin:/bin`,
          SYSTEMCTL_LOG: log,
        },
      });
      expect({ code: result.exitCode, stderr: result.stderr.toString() }).toMatchObject({ code: exit });
      if (exit === 0) {
        expect(readFileSync(log, "utf8")).toContain("daemon-reload");
        expect(paths.every(existsSync)).toBe(operation === "install");
      } else {
        expect(existsSync(log)).toBe(false);
        expect(paths.every(existsSync)).toBe(true);
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

test("maps unavailable flock to manual remediation through the maintainer", async () => {
  const fixture = sandbox();
  try {
    populate(fixture, fixture.userDataRoot);
    const [step] = await Effect.runPromise(
      fixture.maintainer.uninstall.plan({ platform: "linux", userDataRoot: fixture.userDataRoot }),
    );
    if (step === undefined) throw new Error("expected a helper step");
    const result = await Effect.runPromise(
      fixture.maintainer.uninstall.execute({
        platform: "linux",
        userDataRoot: fixture.userDataRoot,
        step,
        elevate: () => Effect.succeed({ exitCode: 4, stdout: "", stderr: "flock unavailable" }),
      }),
    );
    expect(result.outcome).toBe("manual");
    expect(result.detail).toContain("flock");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
