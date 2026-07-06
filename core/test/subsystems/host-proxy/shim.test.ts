import { describe, expect, test } from "bun:test";

import { remapContainerCwd } from "../../../src/subsystems/host-proxy/cwd-remap.ts";
import { buildRunLandoRequest, filterHostProxyEnv } from "../../../src/subsystems/host-proxy/shim.ts";

describe("filterHostProxyEnv", () => {
  test("keeps only LANDO_*, LC_*, LANG, TERM", () => {
    const filtered = filterHostProxyEnv({
      LANDO_APP: "demo",
      LANDO_HOST_PROXY_DEPTH: "1",
      LC_ALL: "en_US.UTF-8",
      LANG: "en_US.UTF-8",
      TERM: "xterm-256color",
      PATH: "/usr/bin",
      SECRET_TOKEN: "s3cr3t",
      HOME: "/root",
    });
    expect(filtered).toEqual({
      LANDO_APP: "demo",
      LANDO_HOST_PROXY_DEPTH: "1",
      LC_ALL: "en_US.UTF-8",
      LANG: "en_US.UTF-8",
      TERM: "xterm-256color",
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
      env: { LANDO_APP: "demo", SECRET: "x" },
    });
    expect(request._tag).toBe("runLando");
    expect(request.argv).toEqual(["open", "--print"]);
    expect(request.cwd).toBe("/app");
    expect(request.tty).toBe(false);
    expect(request.env).toEqual({ LANDO_APP: "demo" });
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

  test("does not treat a sibling prefix as inside the mount", () => {
    expect(remapContainerCwd("/application/web", mount)).toBe("/home/u/site");
  });
});
