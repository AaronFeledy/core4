import { describe, expect, test } from "bun:test";

import { resolveBindSource } from "../src/services/_volume-helpers.ts";

describe("resolveBindSource", () => {
  test("keeps absolute POSIX sources unchanged under a Windows app root", () => {
    expect(resolveBindSource("/var/run/docker.sock", "C:\\proj")).toBe("/var/run/docker.sock");
  });

  test("resolves relative sources against a Windows app root", () => {
    expect(resolveBindSource("./.lando/php/app.ini", "C:\\proj")).toBe("C:\\proj\\.lando\\php\\app.ini");
  });

  test("resolves relative sources against a POSIX app root", () => {
    expect(resolveBindSource("./conf", "/srv/app")).toBe("/srv/app/conf");
  });
});
