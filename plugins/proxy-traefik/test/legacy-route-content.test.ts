import { expect, test } from "bun:test";
import { recognizeLegacyRouteFile } from "../src/legacy-route-content.ts";
import { legacyContent, legacyHttpContent, legacyName } from "./legacy-route-fixture.ts";

test.each([
  [legacyName, legacyContent, true],
  ["routes-plain.yml", legacyHttpContent, false],
])("recognizes the historical writer output for %s", (name, content, hasCertificate) => {
  expect(recognizeLegacyRouteFile(name, content)).toMatchObject({ hasCertificate });
});

test.each([
  [`routes-${"ab".repeat(32)}.yml`, legacyContent.replaceAll("old%2Fapp", "ab".repeat(32))],
  [`routes-${"AB".repeat(32)}.yml`, legacyContent.replaceAll("old%2Fapp", "AB".repeat(32))],
  ["routes-.yml", "http:\n  routers:\n  services:\n"],
  ["routes-empty.yml", "http:\n  routers:\n  services:\n"],
  ["routes-%FF.yml", legacyContent],
  ["routes-%00.yml", legacyContent],
  ["routes-%70lain.yml", legacyHttpContent],
  ["custom.yml", legacyContent],
  ["routes-other.yml", legacyContent],
  [legacyName, `# lando-route-file: {"version":1,"app":"old/app"}\n${legacyContent}`],
  [legacyName, legacyContent.replace("  routers:", "  extra: true\n  routers:")],
  [legacyName, legacyContent.replace("      tls: {}", "      tls: {certResolver: custom}")],
  [legacyName, legacyContent.replace('"prefixes":["/api"]', '"prefixes":["/api"],"forceSlash":true')],
  [legacyName, legacyContent.replace("priority: 65540", "priority: 1")],
  [legacyName, legacyContent.replace("old%2Fapp.key", "other.key")],
  [legacyName, `${legacyContent}# custom edit\n`],
  [legacyName, "http: [broken"],
])("preserves unrecognized file %s (%#)", (name, content) => {
  expect(recognizeLegacyRouteFile(name, content)).toBeUndefined();
});
