import { describe, expect, test } from "bun:test";

import { type SudoInvocationHost, sudoInvocationMessage } from "../../bin/sudo-invocation.ts";

const roots = ["/home/dev/.local/share/lando", "/home/dev/.config/lando", "/home/dev/.cache/lando"];

const host = (overrides: Partial<SudoInvocationHost> = {}): SudoInvocationHost => ({
  euid: 0,
  env: { SUDO_UID: "1000", SUDO_USER: "dev" },
  roots: () => roots,
  ownerOf: () => 1000,
  exists: () => true,
  homeOf: (uid) => (uid === 1000 ? "/home/dev" : undefined),
  ...overrides,
});

describe("sudoInvocationMessage", () => {
  test("an ordinary run never resolves Lando's roots", () => {
    const unresolvable = () => {
      throw new Error("roots resolved");
    };
    expect(sudoInvocationMessage(host({ euid: 1000, roots: unresolvable }))).toBeUndefined();
    expect(sudoInvocationMessage(host({ env: {}, roots: unresolvable }))).toBeUndefined();
  });

  test("refuses sudo when the roots belong to the user who ran sudo", () => {
    const message = sudoInvocationMessage(host());

    expect(message).toContain("/home/dev/.local/share/lando");
    expect(message).toContain("Run lando without sudo");
  });

  test("refuses when a missing root's nearest existing ancestor belongs to that user", () => {
    const message = sudoInvocationMessage(
      host({
        roots: () => ["/srv/dev-lando/data"],
        homeOf: () => "/home/dev",
        exists: (path) => path === "/srv/dev-lando",
        ownerOf: (path) => (path === "/srv/dev-lando" ? 1000 : 0),
      }),
    );

    expect(message).toContain("/srv/dev-lando/data");
  });

  test.each([
    ["not running as root", host({ euid: 1000 })],
    ["root without sudo (a root-only environment)", host({ env: {} })],
    ["sudo from root", host({ env: { SUDO_UID: "0" } })],
    [
      "roots owned by root outside the user's home",
      host({ roots: () => ["/var/lib/lando"], ownerOf: () => 0, homeOf: () => "/home/dev" }),
    ],
  ])("allows %s", (_name, candidate) => {
    expect(sudoInvocationMessage(candidate)).toBeUndefined();
  });

  test("a sibling directory that only shares the home prefix is not under the home", () => {
    expect(
      sudoInvocationMessage(
        host({ roots: () => ["/home/dev2/lando"], ownerOf: () => 0, homeOf: () => "/home/dev" }),
      ),
    ).toBeUndefined();
  });
});
