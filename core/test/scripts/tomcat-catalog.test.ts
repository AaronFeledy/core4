import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildTomcatCatalog } from "../../../scripts/build-tomcat-catalog.ts";
import { TOMCAT_MAJORS, validateTomcatConfig, validateTomcatPair } from "../../../scripts/tomcat-config.ts";
import { readTomcatSnapshot } from "../../../scripts/update-tomcat.ts";

const root = resolve(import.meta.dirname, "../../..");
describe("offline Tomcat catalog", () => {
  test("embeds each verified local baseline with its immutable index reference deterministically", async () => {
    // Given
    const snapshot = await readTomcatSnapshot(resolve(root, "plugins/service-lando/tomcat"));
    // When
    const generated = await buildTomcatCatalog(root);
    // Then
    expect(await buildTomcatCatalog(root)).toBe(generated);
    expect(generated.startsWith("/**\n * **GENERATED FILE** — do not edit by hand.")).toBe(true);
    for (const major of TOMCAT_MAJORS) {
      const pin = snapshot.pins.majors[major];
      validateTomcatPair(major, pin, snapshot.configs[major]);
      expect(generated).toContain(`tomcat:${pin.version}-jre21@${pin.indexDigest}`);
    }
    expect(generated.match(/\{\{HTTP_PORT\}\}/gu)).toHaveLength(3);
  });

  test("refuses to generate from a baseline whose bytes no longer match the pin", async () => {
    // Given
    const temporary = await mkdtemp(resolve(tmpdir(), "tomcat-codegen-"));
    const directory = resolve(temporary, "plugins/service-lando/tomcat");
    const snapshot = await readTomcatSnapshot(resolve(root, "plugins/service-lando/tomcat"));
    try {
      await Bun.write(resolve(directory, "pins.json"), JSON.stringify(snapshot.pins));
      for (const major of TOMCAT_MAJORS)
        await Bun.write(resolve(directory, `server-${major}.xml`), `${snapshot.configs[major]} `);
      // When / Then
      await expect(buildTomcatCatalog(temporary)).rejects.toThrow("baseline version/hash");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test.each(["missing-realm", "duplicate-connector", "unclosed-server", "new-active-element"])(
    "rejects unreviewed config shape: %s",
    async (kind) => {
      // Given
      const snapshot = await readTomcatSnapshot(resolve(root, "plugins/service-lando/tomcat"));
      const xml = snapshot.configs["11"];
      const variants: Readonly<Record<string, string>> = {
        "missing-realm": xml.replace(
          'className="org.apache.catalina.realm.LockOutRealm"',
          'className="other.Realm"',
        ),
        "duplicate-connector": xml.replace(
          "</Service>",
          '<Connector port="8080" protocol="HTTP/1.1"/></Service>',
        ),
        "unclosed-server": xml.replace("</Server>", ""),
        "new-active-element": xml.replace("</Server>", "<Unknown/></Server>"),
      };
      // When / Then
      expect(() => validateTomcatConfig(variants[kind] ?? "", "11")).toThrow();
    },
  );
});
