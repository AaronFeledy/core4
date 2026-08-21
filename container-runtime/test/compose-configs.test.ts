import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import {
  bindSourceForComposeConfig,
  composeConfigBindStrings,
  composeConfigMounts,
} from "../src/compose-configs.ts";

const appRoot = mkdtempSync(join(tmpdir(), "lando-compose-config-mounts-"));
const configPath = join(appRoot, "php.ini");
writeFileSync(configPath, "memory_limit=512M\n");

const plan = {
  id: "app-id",
  name: "myapp",
  slug: "myapp",
  root: appRoot,
  extensions: {
    compose: {
      configs: {
        phpini: { file: "./php.ini" },
      },
    },
  },
} as unknown as AppPlan;

const service = {
  name: "web",
  extensions: {
    compose: {
      configs: [
        { source: "phpini" },
        { source: "phpini", target: "/usr/local/etc/php/conf.d/zz-custom.ini", mode: "0444" },
      ],
    },
  },
} as unknown as ServicePlan;

describe("compose config mounts", () => {
  test("Given short and long grants, when resolving mounts, then source target and mode are honored", () => {
    const mounts = composeConfigMounts(plan, service);
    expect(mounts).toEqual([
      { source: configPath, target: "/phpini", readOnly: true },
      {
        source: configPath,
        target: "/usr/local/etc/php/conf.d/zz-custom.ini",
        readOnly: true,
        mode: 0o444,
      },
    ]);
  });

  test("Given a mode, when realizing the bind source, then the copy is read-only", () => {
    const mounts = composeConfigMounts(plan, service);
    const withMode = mounts[1];
    if (withMode === undefined) throw new Error("expected mode-bearing mount");
    const realized = bindSourceForComposeConfig(withMode);
    expect(realized).not.toBe(configPath);
    expect(statSync(realized).mode & 0o777).toBe(0o444);
  });

  test("Given a mode-bearing copy, when realizing again after content change, then the copy updates", async () => {
    const mounts = composeConfigMounts(plan, service);
    const withMode = mounts[1];
    if (withMode === undefined) throw new Error("expected mode-bearing mount");
    const first = bindSourceForComposeConfig(withMode);
    expect(statSync(first).mode & 0o777).toBe(0o444);
    writeFileSync(configPath, "memory_limit=256M\n");
    const second = bindSourceForComposeConfig(withMode);
    expect(second).toBe(first);
    expect(await Bun.file(second).text()).toBe("memory_limit=256M\n");
    expect(statSync(second).mode & 0o777).toBe(0o444);
    writeFileSync(configPath, "memory_limit=512M\n");
  });

  test("Given grants, when building bind strings, then each mount is read-only", () => {
    const binds = composeConfigBindStrings(plan, service);
    expect(binds).toHaveLength(2);
    expect(binds[0]).toBe(`${configPath}:/phpini:ro`);
    expect(binds[1]?.startsWith(configPath)).toBe(false);
    expect(binds[1]?.endsWith(":/usr/local/etc/php/conf.d/zz-custom.ini:ro")).toBe(true);
  });
});
