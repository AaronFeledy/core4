import { describe, expect, test } from "bun:test";

import { AppId } from "@lando/sdk/schema";

import {
  OWNER_ROUTE_KEY_PATTERN,
  ROUTE_FILE_METADATA_PREFIX,
  isOwnerLayoutRouteFile,
  isOwnerRouteFileName,
  isRouteFileName,
  parseRouteFileMetadata,
  renderRouteFileMetadata,
} from "../src/route-file-metadata.ts";

const ownerKey = "ab".repeat(32);
const app = AppId.make("demo");

describe("route file metadata helpers", () => {
  test("renderRouteFileMetadata stamps version 1 and the app id", () => {
    const line = renderRouteFileMetadata(app);
    expect(line.startsWith(ROUTE_FILE_METADATA_PREFIX)).toBe(true);
    expect(line).toBe(`# lando-route-file: ${JSON.stringify({ version: 1, app: "demo" })}`);
    expect(parseRouteFileMetadata(`${line}\nhttp:\n`)).toEqual({ version: 1, app });
  });

  test("parseRouteFileMetadata accepts full content and validates version/id", () => {
    const content = `${renderRouteFileMetadata(app)}\nhttp:\n  routers: {}\n`;
    expect(parseRouteFileMetadata(content)).toEqual({ version: 1, app });

    // Only line 0 counts.
    expect(parseRouteFileMetadata(`http:\n${renderRouteFileMetadata(app)}\n`)).toBeUndefined();
    expect(parseRouteFileMetadata(` ${renderRouteFileMetadata(app)}\n`)).toBeUndefined();

    // Wrong version.
    expect(
      parseRouteFileMetadata(`${ROUTE_FILE_METADATA_PREFIX}${JSON.stringify({ version: 2, app: "demo" })}\n`),
    ).toBeUndefined();

    // Missing app.
    expect(
      parseRouteFileMetadata(`${ROUTE_FILE_METADATA_PREFIX}${JSON.stringify({ version: 1 })}\n`),
    ).toBeUndefined();

    // Malformed JSON.
    expect(parseRouteFileMetadata(`${ROUTE_FILE_METADATA_PREFIX}{not-json}\n`)).toBeUndefined();

    // Non-string app rejected by schema.
    expect(
      parseRouteFileMetadata(`${ROUTE_FILE_METADATA_PREFIX}${JSON.stringify({ version: 1, app: 12 })}\n`),
    ).toBeUndefined();
  });

  test("owner filename is routes-<64 lowercase hex>.yml", () => {
    expect(OWNER_ROUTE_KEY_PATTERN.test(ownerKey)).toBe(true);
    expect(isOwnerRouteFileName(`routes-${ownerKey}.yml`)).toBe(true);
    expect(isOwnerRouteFileName("routes-demo.yml")).toBe(false);
    expect(isOwnerRouteFileName(`routes-${ownerKey.toUpperCase()}.yml`)).toBe(false);
    expect(isOwnerRouteFileName(`routes-${ownerKey}a.yml`)).toBe(false);
    expect(isOwnerRouteFileName(`routes-${ownerKey.slice(0, 63)}.yml`)).toBe(false);
    expect(isRouteFileName("routes-demo.yml")).toBe(true);
    expect(isRouteFileName("fallback.yml")).toBe(false);
  });

  test("isOwnerLayoutRouteFile requires both filename and valid metadata", () => {
    const good = `${renderRouteFileMetadata(app)}\nhttp:\n`;
    expect(isOwnerLayoutRouteFile(`routes-${ownerKey}.yml`, good)).toBe(true);
    expect(isOwnerLayoutRouteFile("routes-demo.yml", good)).toBe(false);
    expect(isOwnerLayoutRouteFile(`routes-${ownerKey}.yml`, "http:\n")).toBe(false);
    expect(
      isOwnerLayoutRouteFile(
        `routes-${ownerKey}.yml`,
        `${ROUTE_FILE_METADATA_PREFIX}${JSON.stringify({ version: 2, app: "demo" })}\n`,
      ),
    ).toBe(false);
  });
});
