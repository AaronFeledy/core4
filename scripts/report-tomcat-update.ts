import { readTomcatSnapshot, reportTomcatUpdate } from "./update-tomcat.ts";

if (import.meta.main) {
  const [previous, candidate] = process.argv.slice(2);
  if (previous === undefined || candidate === undefined || process.argv.length !== 4) {
    throw new TypeError(
      "Usage: bun run scripts/report-tomcat-update.ts <previous-directory> <candidate-directory>",
    );
  }
  process.stdout.write(
    reportTomcatUpdate(await readTomcatSnapshot(previous), await readTomcatSnapshot(candidate)),
  );
}
