#!/usr/bin/env bun
import {
  readNodeReleasesManifest,
  reportNodeReleasesUpdate,
  transformNodeSchedule,
} from "./node-releases.ts";
import { readNodeSchedule, todayIsoDate } from "./update-node-releases.ts";

if (import.meta.main) {
  const [previousPath, candidatePath] = process.argv.slice(2);
  if (previousPath === undefined || candidatePath === undefined || process.argv.length !== 4) {
    throw new TypeError(
      "Usage: bun run scripts/report-node-releases-update.ts <previous-manifest.json> <candidate-manifest.json>",
    );
  }
  const previous = await readNodeReleasesManifest(previousPath);
  const candidate = await readNodeReleasesManifest(candidatePath);
  const { newLtsMajors } = transformNodeSchedule(await readNodeSchedule(), previous, todayIsoDate());
  process.stdout.write(reportNodeReleasesUpdate(previous, candidate, newLtsMajors));
}
