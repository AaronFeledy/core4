import { describe, expect, test } from "bun:test";

import {
  AGENT_SESSION_LABEL,
  APP_LABEL,
  APP_ROOT_LABEL,
  PROVIDER_LABEL,
  SCRATCH_ID_LABEL,
  SCRATCH_LABEL,
  SERVICE_LABEL,
  STORAGE_KIND_LABEL,
  STORAGE_SCOPE_LABEL,
  STORE_LABEL,
  VOLUME_INSTANCE_LABEL,
  VOLUME_OWNER_LABEL,
  VOLUME_SELECTOR_LABEL,
} from "../src/labels.ts";
import {
  STORAGE_KIND_LABEL as storageKindFromClasses,
  STORAGE_SCOPE_LABEL as storageScopeFromClasses,
} from "../src/volume-classes.ts";
import {
  VOLUME_OWNER_LABEL as ownerFromOwnership,
  VOLUME_SELECTOR_LABEL as selectorFromOwnership,
} from "../src/volume-ownership.ts";

describe("container runtime label constants", () => {
  test("pins every lando label literal", () => {
    expect(APP_LABEL).toBe("dev.lando.app");
    expect(APP_ROOT_LABEL).toBe("dev.lando.app-root");
    expect(SERVICE_LABEL).toBe("dev.lando.service");
    expect(PROVIDER_LABEL).toBe("dev.lando.provider");
    expect(STORE_LABEL).toBe("dev.lando.store");
    expect(VOLUME_INSTANCE_LABEL).toBe("dev.lando.volume-instance");
    expect(SCRATCH_LABEL).toBe("dev.lando.scratch");
    expect(SCRATCH_ID_LABEL).toBe("dev.lando.scratch-id");
    expect(AGENT_SESSION_LABEL).toBe("dev.lando.agent-session");
    expect(VOLUME_OWNER_LABEL).toBe("dev.lando.volume-owner");
    expect(VOLUME_SELECTOR_LABEL).toBe("dev.lando.volume-selector");
    expect(STORAGE_KIND_LABEL).toBe("dev.lando.storage-kind");
    expect(STORAGE_SCOPE_LABEL).toBe("dev.lando.scope");
  });

  test("re-exports ownership and storage labels from their producers", () => {
    expect(VOLUME_OWNER_LABEL).toBe(ownerFromOwnership);
    expect(VOLUME_SELECTOR_LABEL).toBe(selectorFromOwnership);
    expect(STORAGE_KIND_LABEL).toBe(storageKindFromClasses);
    expect(STORAGE_SCOPE_LABEL).toBe(storageScopeFromClasses);
  });
});
