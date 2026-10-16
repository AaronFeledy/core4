import { resolve } from "node:path";
import { Schema } from "effect";
import { writeFormattedOutput } from "./_codegen-output.ts";
import { HTTP_CONNECTOR, TOMCAT_MAJORS, TomcatPins, validateTomcatPair } from "./tomcat-config.ts";

const root = resolve(import.meta.dirname, "..");
export const buildTomcatCatalog = async (repositoryRoot = root): Promise<string> => {
  const directory = resolve(repositoryRoot, "plugins/service-lando/tomcat");
  const pins = Schema.decodeUnknownSync(TomcatPins)(await Bun.file(resolve(directory, "pins.json")).json());
  const entries = await Promise.all(
    TOMCAT_MAJORS.map(async (major) => {
      const pin = pins.majors[major];
      const xml = await Bun.file(resolve(directory, `server-${major}.xml`)).text();
      validateTomcatPair(major, pin, xml);
      // Replace only the reviewed active opening; the shared-executor example has a different opening.
      return [
        major,
        {
          image: `tomcat:${pin.version}-jre21@${pin.indexDigest}`,
          serverXml: xml
            .replace("?>", "?>\n<!-- Modified by Lando: active HTTP connector port is configurable. -->")
            .replace(HTTP_CONNECTOR, '<Connector port="{{HTTP_PORT}}" protocol="HTTP/1.1"'),
        },
      ];
    }),
  );
  return `/**\n * **GENERATED FILE** — do not edit by hand.\n * Regenerate via bun run codegen:tomcat-catalog.\n */\nexport const TOMCAT_CATALOG = ${JSON.stringify(Object.fromEntries(entries), null, 2)} as const;\n`;
};
if (import.meta.main) {
  await writeFormattedOutput(
    resolve(root, "plugins/service-lando/src/services/generated/tomcat-catalog.ts"),
    await buildTomcatCatalog(),
  );
}
