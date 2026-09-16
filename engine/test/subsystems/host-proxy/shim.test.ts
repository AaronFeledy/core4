import { describe, expect, test } from "bun:test";

import {
  remapContainerCwd,
  remapHostCwd,
  resolveContainerCwd,
  tryMapHostCwd,
} from "../../../src/subsystems/host-proxy/cwd-remap.ts";
import { buildRunLandoRequest, filterHostProxyEnv } from "../../../src/subsystems/host-proxy/shim.ts";

describe("filterHostProxyEnv", () => {
  test("keeps safe host-proxy and agent-context env names", () => {
    const filtered = filterHostProxyEnv({
      LANDO_APP: "demo",
      LANDO_HOST_PROXY_DEPTH: "1",
      LC_ALL: "en_US.UTF-8",
      LANG: "en_US.UTF-8",
      TERM: "xterm-256color",
      OPENCODE: "1",
      AGENT: "true",
      PATH: "/usr/bin",
      SECRET_TOKEN: "s3cr3t",
      HOME: "/root",
    });
    expect(filtered).toEqual({
      LANDO_APP: "demo",
      LC_ALL: "en_US.UTF-8",
      LANG: "en_US.UTF-8",
      TERM: "xterm-256color",
      OPENCODE: "1",
      AGENT: "true",
    });
  });

  test("drops a bare LANG-lookalike and keeps exact TERM/LANG", () => {
    const filtered = filterHostProxyEnv({ LANGUAGE: "x", TERMINAL: "y", LANG: "z", TERM: "t" });
    expect(filtered).toEqual({ LANG: "z", TERM: "t" });
  });

  test("returns an empty object when nothing matches", () => {
    expect(filterHostProxyEnv({ PATH: "/usr/bin", FOO: "bar" })).toEqual({});
  });
});

describe("buildRunLandoRequest", () => {
  test("builds a runLando request with filtered env", () => {
    const request = buildRunLandoRequest({
      argv: ["open", "--print"],
      cwd: "/app",
      tty: false,
      env: { LANDO_APP: "demo", OPENCODE: "1", SECRET: "x" },
    });
    expect(request._tag).toBe("runLando");
    expect(request.argv).toEqual(["open", "--print"]);
    expect(String(request.cwd)).toBe("/app");
    expect(request.tty).toBe(false);
    expect(request.env).toEqual({ LANDO_APP: "demo", OPENCODE: "1" });
  });

  test("omits env when the filtered set is empty", () => {
    const request = buildRunLandoRequest({ argv: ["open"], cwd: "/app", tty: true, env: { PATH: "/x" } });
    expect(request.env).toBeUndefined();
  });

  test("omits env when no env is supplied", () => {
    const request = buildRunLandoRequest({ argv: ["open"], cwd: "/app", tty: true });
    expect(request.env).toBeUndefined();
  });
});

describe("remapContainerCwd", () => {
  const mount = { containerRoot: "/app", hostRoot: "/home/u/site" };

  test("remaps a path under the container root to the host root", () => {
    expect(remapContainerCwd("/app/web", mount)).toBe("/home/u/site/web");
  });

  test("maps the container root itself to the host root", () => {
    expect(remapContainerCwd("/app", mount)).toBe("/home/u/site");
  });

  test("falls back to the host root for a path outside the mount", () => {
    expect(remapContainerCwd("/var/tmp", mount)).toBe("/home/u/site");
  });

  test("collapses parent-directory escapes back to the host root", () => {
    expect(remapContainerCwd("/app/../../.ssh", mount)).toBe("/home/u/site");
  });

  test("collapses mid-path parent-directory escapes back to the host root", () => {
    expect(remapContainerCwd("/app/foo/../../etc/passwd", mount)).toBe("/home/u/site");
  });

  test("does not treat a sibling prefix as inside the mount", () => {
    expect(remapContainerCwd("/application/web", mount)).toBe("/home/u/site");
  });
});

describe("remapHostCwd", () => {
  const mount = { containerRoot: "/app", hostRoot: "/home/u/site" };

  test("remaps a host path under the mount to the container root", () => {
    expect(remapHostCwd("/home/u/site/web", mount)).toBe("/app/web");
  });

  test("maps the host root itself to the container root", () => {
    expect(remapHostCwd("/home/u/site", mount)).toBe("/app");
  });

  test("returns undefined for a path outside the mount", () => {
    expect(remapHostCwd("/var/tmp", mount)).toBeUndefined();
  });

  test("does not treat a sibling prefix as inside the mount", () => {
    expect(remapHostCwd("/home/u/site2/web", mount)).toBeUndefined();
  });

  test("never resolves a relative path against the process cwd", () => {
    const original = process.cwd();
    process.chdir("/");
    try {
      expect(remapHostCwd("web", { containerRoot: "/app", hostRoot: "/" })).toBeUndefined();
    } finally {
      process.chdir(original);
    }
  });
});

describe("tryMapHostCwd", () => {
  test("prefers the longest matching host root", () => {
    const mapped = tryMapHostCwd("/home/u/site/web/modules", [
      { hostRoot: "/home/u/site", containerRoot: "/app" },
      { hostRoot: "/home/u/site/web", containerRoot: "/app/web" },
    ]);
    expect(mapped).toBe("/app/web/modules");
  });
});

describe("resolveContainerCwd", () => {
  const mounted = {
    appMount: { source: "/workspace/drupal", target: "/app" },
    mounts: [] as const,
    workingDirectory: "/app/web",
  };
  const unmounted = {
    mounts: [] as const,
    workingDirectory: "/srv/worker",
  };
  const bare = { mounts: [] as const };

  test("maps an explicit host path under a bind mount", () => {
    // Given: an explicit cwd under the app mount source.
    // When: container cwd is resolved.
    // Then: the matching container path is returned.
    expect(resolveContainerCwd(mounted, "/workspace/drupal/web", "/tmp")).toBe("/app/web");
  });

  test("keeps an explicit container path that is not under a host mount", () => {
    expect(resolveContainerCwd(mounted, "/app/web", "/tmp")).toBe("/app/web");
  });

  test("keeps a relative authored dir verbatim regardless of where the command was invoked", () => {
    // Given: a landofile task `dir: web` and the user invoking from inside the app mount.
    const original = process.cwd();
    process.chdir("/");
    try {
      // Then: `web` must not be resolved against the process cwd and re-mapped.
      expect(resolveContainerCwd(mounted, "web", "/workspace/drupal/web")).toBe("web");
      expect(resolveContainerCwd({ ...mounted, appMount: { source: "/", target: "/app" } }, "web", "/")).toBe(
        "web",
      );
    } finally {
      process.chdir(original);
    }
  });

  test("maps an implicit host cwd under a bind mount", () => {
    expect(resolveContainerCwd(mounted, undefined, "/workspace/drupal/web")).toBe("/app/web");
  });

  test("falls back to the app mount target when the implicit host cwd is unmappable", () => {
    expect(resolveContainerCwd(mounted, undefined, "/home/aaron/somewhere/else")).toBe("/app");
  });

  test("falls back to workingDirectory when implicit host cwd is unmappable and there is no app mount", () => {
    expect(resolveContainerCwd(unmounted, undefined, "/home/aaron/somewhere/else")).toBe("/srv/worker");
  });

  test("returns undefined when there is no app mount and no workingDirectory", () => {
    expect(resolveContainerCwd(bare, undefined, "/home/aaron/somewhere/else")).toBeUndefined();
  });
});
