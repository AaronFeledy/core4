import type { AppFeatureDefinition } from "@lando/sdk/services";

import { phpMyAdminWireFeature } from "../services/phpmyadmin.ts";

export const appFeatures: ReadonlyMap<string, AppFeatureDefinition> = new Map([
  [phpMyAdminWireFeature.id, phpMyAdminWireFeature],
]);
