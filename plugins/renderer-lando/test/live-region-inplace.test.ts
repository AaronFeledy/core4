import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resetLiveRegionModuleCacheForTests } from "../src/opentui/live-region-substrate.ts";
import { resetOpenTuiSubstrateAvailabilityForTests } from "../src/opentui/substrate-availability.ts";
import {
  createTestLiveRegionController as createController,
  makeLiveRegionFixture as makeFixture,
} from "./live-region-test-kit.ts";

const ESC = String.fromCharCode(27);

const written = (fixture: ReturnType<typeof makeFixture>): string => fixture.writes.join("");

beforeEach(() => {
  resetLiveRegionModuleCacheForTests();
});

afterEach(() => {
  resetOpenTuiSubstrateAvailabilityForTests();
  resetLiveRegionModuleCacheForTests();
});

describe("LiveRegionController in-place progress", () => {
  test("keeps Composer CSI cursor progress on one line and does not paint footer over it", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);
    controller.setFooter(["executing composer  0ms"]);
    fixture.writes.length = 0;

    const first = `${ESC}[1G${ESC}[2K  0/108 [>---------------------------]   0%`;
    const second = `${ESC}[1G${ESC}[2K  53/108 [=============>--------------]  49%`;
    controller.commitScrollback(first);
    controller.setFooter(["executing composer  400ms"]);
    controller.commitScrollback(second);

    const text = written(fixture);
    expect(text).toContain(first);
    expect(text).toContain(second);
    expect(text.endsWith("\n")).toBe(false);
    expect(text.split("\n").filter((line) => line.includes("/108")).length).toBe(1);
    expect(text).not.toContain("executing composer  400ms");
  });

  test("keeps the first plain Composer progress frame on the same line as later CSI updates", async () => {
    const fixture = makeFixture();
    const controller = await createController(fixture);
    controller.setFooter(["executing composer  0ms"]);
    fixture.writes.length = 0;

    const first = "  0/108 [>---------------------------]   0%";
    const second = `${ESC}[1G${ESC}[2K  53/108 [=============>--------------]  49%`;
    controller.commitScrollback(first);
    controller.setFooter(["executing composer  400ms"]);
    controller.commitScrollback(second);

    const text = written(fixture);
    expect(text.endsWith(`${first}${second}`)).toBe(true);
    expect(text.split("\n").filter((line) => line.includes("/108")).length).toBe(1);
    expect(text).not.toContain("executing composer  400ms");
  });
});
