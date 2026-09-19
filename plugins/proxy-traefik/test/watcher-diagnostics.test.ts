import { describe, expect, test } from "bun:test";

import {
  boundWatcherDetail,
  classifyWatcherFailure,
  watcherHostLabel,
  watcherRemediations,
} from "../src/watcher-diagnostics.ts";

type WatcherFailureClass = "inotify-limit" | "disk" | "permission" | "other";

const FAILURE_CLASSES = [
  "inotify-limit",
  "disk",
  "permission",
  "other",
] as const satisfies ReadonlyArray<WatcherFailureClass>;

describe("classifyWatcherFailure", () => {
  test("classifies too many open files from file.Provider as inotify-limit", () => {
    // Given: Traefik v3 log where fsnotify.NewWatcher hit EMFILE.
    const logText =
      'level=error msg="Cannot start the provider *file.Provider" error="error creating file watcher: too many open files"';

    // When: classify the log text.
    const result = classifyWatcherFailure(logText);

    // Then: failureClass is inotify-limit.
    expect(result).toBeDefined();
    expect(result?.failureClass).toBe("inotify-limit");
    expect(result?.detail).toContain("too many open files");
  });

  test("classifies ENOSPC from inotify_add_watch as inotify-limit, not disk", () => {
    // Given: Traefik wraps watcher.Add ENOSPC as "error adding file watcher for %s: no space left on device".
    // On Linux, inotify_add_watch returning ENOSPC means max_user_watches is exhausted, not a full disk.
    const logText =
      'level=error msg="Cannot start the provider *file.Provider" error="error adding file watcher for /etc/traefik/dynamic: no space left on device"';

    // When: classify the log text.
    const result = classifyWatcherFailure(logText);

    // Then: inotify-limit, explicitly not disk (ENOSPC from inotify_add_watch is max_user_watches).
    expect(result).toBeDefined();
    expect(result?.failureClass).toBe("inotify-limit");
    expect(result?.failureClass).not.toBe("disk");
    expect(result?.detail).toContain("no space left on device");
  });

  test("classifies too many open files in system as inotify-limit", () => {
    // Given: EMFILE variant with "in system" suffix from creating the watcher.
    const logText =
      'level=error msg="Cannot start the provider *file.Provider" error="error creating file watcher: too many open files in system"';

    // When: classify the log text.
    const result = classifyWatcherFailure(logText);

    // Then: inotify-limit.
    expect(result).toBeDefined();
    expect(result?.failureClass).toBe("inotify-limit");
  });

  test("classifies permission denied from adding a file watcher as permission", () => {
    // Given: Traefik cannot Add a watch path due to EACCES.
    const logText =
      'level=error msg="Cannot start the provider *file.Provider" error="error adding file watcher for /etc/traefik/dynamic: permission denied"';

    // When: classify the log text.
    const result = classifyWatcherFailure(logText);

    // Then: permission.
    expect(result).toBeDefined();
    expect(result?.failureClass).toBe("permission");
  });

  test("classifies permission denied from unable to read directory as permission", () => {
    // Given: Traefik cannot read the dynamic config directory.
    const logText =
      'level=error msg="Cannot start the provider *file.Provider" error="unable to read directory /etc/traefik/dynamic: permission denied"';

    // When: classify the log text.
    const result = classifyWatcherFailure(logText);

    // Then: permission.
    expect(result).toBeDefined();
    expect(result?.failureClass).toBe("permission");
  });

  test("classifies input/output error from adding a file watcher as disk", () => {
    // Given: EIO while adding a watch path.
    const logText =
      'level=error msg="Cannot start the provider *file.Provider" error="error adding file watcher for /etc/traefik/dynamic: input/output error"';

    // When: classify the log text.
    const result = classifyWatcherFailure(logText);

    // Then: disk.
    expect(result).toBeDefined();
    expect(result?.failureClass).toBe("disk");
  });

  test("classifies read-only file system from adding a file watcher as disk", () => {
    // Given: EROFS while adding a watch path.
    const logText =
      'level=error msg="Cannot start the provider *file.Provider" error="error adding file watcher for /etc/traefik/dynamic: read-only file system"';

    // When: classify the log text.
    const result = classifyWatcherFailure(logText);

    // Then: disk.
    expect(result).toBeDefined();
    expect(result?.failureClass).toBe("disk");
  });

  test("classifies no space left on device from unable to read directory as disk", () => {
    // Given: real disk ENOSPC when reading the directory (not inotify_add_watch).
    const logText =
      'level=error msg="Cannot start the provider *file.Provider" error="unable to read directory /etc/traefik/dynamic: no space left on device"';

    // When: classify the log text.
    const result = classifyWatcherFailure(logText);

    // Then: disk (directory read ENOSPC is a full volume, not max_user_watches).
    expect(result).toBeDefined();
    expect(result?.failureClass).toBe("disk");
  });

  test("classifies unrecognized watcher create errno as other", () => {
    // Given: an errno that is not inotify/disk/permission.
    const logText =
      'level=error msg="Cannot start the provider *file.Provider" error="error creating file watcher: exec format error"';

    // When: classify the log text.
    const result = classifyWatcherFailure(logText);

    // Then: other.
    expect(result).toBeDefined();
    expect(result?.failureClass).toBe("other");
  });

  test("returns undefined for fsnotify queue overflow without file.Provider wrapper", () => {
    // Given: a watcher event error with no Cannot start the provider *file.Provider context.
    const logText = 'level=error msg="Watcher event error" error="fsnotify: queue or buffer overflow"';

    // When: classify the log text.
    const result = classifyWatcherFailure(logText);

    // Then: undefined (precision gate: no file-provider wrapper).
    expect(result).toBeUndefined();
  });

  test("returns undefined for unscoped no space left on device without watcher context", () => {
    // Given: ENOSPC on an unrelated cache write, no file watcher framing.
    const logText = 'level=error msg="failed to write cache" error="no space left on device"';

    // When: classify the log text.
    const result = classifyWatcherFailure(logText);

    // Then: undefined (precision gate: unscoped errno).
    expect(result).toBeUndefined();
  });

  test("returns undefined for empty string", () => {
    // Given: empty log text.
    const logText = "";

    // When: classify the log text.
    const result = classifyWatcherFailure(logText);

    // Then: undefined.
    expect(result).toBeUndefined();
  });

  test("returns undefined for Traefik Starting provider *file.Provider INFO", () => {
    // Given: the normal Traefik v3 INFO line that names the file provider.
    const logText = 'level=info msg="Starting provider *file.Provider"';

    // When: classify the log text.
    const result = classifyWatcherFailure(logText);

    // Then: healthy provider start is not a watcher failure.
    expect(result).toBeUndefined();
  });

  test("classifies ENOSPC after a healthy Starting provider *file.Provider line as inotify-limit", () => {
    // Given: realistic Traefik framing, healthy start then inotify ENOSPC.
    const logText = [
      'level=info msg="Starting provider *file.Provider"',
      'level=error msg="Cannot start the provider *file.Provider" error="error adding file watcher for /etc/traefik/dynamic: no space left on device"',
    ].join("\n");

    // When: classify the log text.
    const result = classifyWatcherFailure(logText);

    // Then: the healthy start line does not mask the inotify failure.
    expect(result).toBeDefined();
    expect(result?.failureClass).toBe("inotify-limit");
  });

  test("ignores a historical watcher error before the latest Starting provider *file.Provider", () => {
    // Given: an earlier ENOSPC, then a later clean file-provider start.
    const logText = [
      'level=error msg="Cannot start the provider *file.Provider" error="error adding file watcher for /etc/traefik/dynamic: no space left on device"',
      'level=info msg="Starting provider *file.Provider"',
      'level=info msg="Configuration loaded from flags."',
    ].join("\n");

    // When: classify the log text.
    const result = classifyWatcherFailure(logText);

    // Then: only the latest startup window is classified.
    expect(result).toBeUndefined();
  });

  test("returns undefined for multi-line healthy INFO logs", () => {
    // Given: healthy Traefik INFO lines with no provider start failure.
    const logText = [
      'level=info msg="Configuration loaded from flags."',
      'level=info msg="Server configuration reloaded on :80"',
    ].join("\n");

    // When: classify the log text.
    const result = classifyWatcherFailure(logText);

    // Then: undefined.
    expect(result).toBeUndefined();
  });

  test("bounds detail length for a long matching single log line", () => {
    // Given: a 2000-character single log line that matches the ENOSPC inotify_add_watch rule.
    const matched =
      'level=error msg="Cannot start the provider *file.Provider" error="error adding file watcher for /etc/traefik/dynamic: no space left on device"';
    const padding = "x".repeat(2000 - matched.length);
    const logText = `${matched}${padding}`;
    expect(logText.length).toBe(2000);

    // When: classify the log text.
    const result = classifyWatcherFailure(logText);

    // Then: detail is non-empty, contains matched content, and is at most 300 chars.
    expect(result).toBeDefined();
    expect(result?.failureClass).toBe("inotify-limit");
    expect(result?.detail.length).toBeGreaterThan(0);
    expect(result?.detail).toContain("no space left on device");
    expect(result?.detail.length).toBe(2000);
    expect(boundWatcherDetail(result?.detail ?? "").length).toBeLessThanOrEqual(300);
  });

  test("detail from multi-line log excludes non-matching lines", () => {
    // Given: multi-line log where only the 4th line matches; line 1 has a distinctive token.
    const distinctiveToken = "UNIQUE_NONMATCH_TOKEN_LINE1_XYZ";
    const logText = [
      `level=info msg="${distinctiveToken}"`,
      'level=info msg="Configuration loaded from flags."',
      'level=debug msg="unrelated noise"',
      'level=error msg="Cannot start the provider *file.Provider" error="error adding file watcher for /etc/traefik/dynamic: permission denied"',
    ].join("\n");

    // When: classify the log text.
    const result = classifyWatcherFailure(logText);

    // Then: detail does not contain the non-matching line-1 token.
    expect(result).toBeDefined();
    expect(result?.failureClass).toBe("permission");
    expect(result?.detail).not.toContain(distinctiveToken);
  });
});

describe("watcherHostLabel", () => {
  test("labels lando on linux as this Linux host", () => {
    // Given: provider lando on linux.
    const input = { providerId: "lando", platform: "linux" as const };

    // When: build the host label.
    const label = watcherHostLabel(input);

    // Then: exact phrasing for a bare Linux host.
    expect(label).toBe("this Linux host");
  });

  test("labels lando on wsl as this WSL distribution", () => {
    // Given: provider lando on wsl.
    const input = { providerId: "lando", platform: "wsl" as const };

    // When: build the host label.
    const label = watcherHostLabel(input);

    // Then: exact phrasing for WSL.
    expect(label).toBe("this WSL distribution");
  });

  test("labels lando on darwin and win32 as the Lando-managed Podman machine", () => {
    // Given: provider lando on darwin and win32 (watcher runs inside the managed VM).
    // When: build host labels for both platforms.
    const darwin = watcherHostLabel({ providerId: "lando", platform: "darwin" });
    const win32 = watcherHostLabel({ providerId: "lando", platform: "win32" });

    // Then: both name the Lando-managed Podman machine.
    expect(darwin).toBe("the Lando-managed Podman machine");
    expect(win32).toBe("the Lando-managed Podman machine");
  });

  test("labels non-lando provider on darwin with the container runtime VM phrasing", () => {
    // Given: provider docker on darwin.
    const input = { providerId: "docker", platform: "darwin" as const };

    // When: build the host label.
    const label = watcherHostLabel(input);

    // Then: exact phrasing with backticks around the provider id.
    expect(label).toBe("the container runtime virtual machine for provider `docker`");
  });
});

describe("watcherRemediations", () => {
  test("returns non-empty manual-only remediations for every failure class", () => {
    // Given: a watcher host label and all four failure classes.
    const watcherHost = "this Linux host";

    for (const failureClass of FAILURE_CLASSES) {
      // When: build remediations for the class.
      const entries = watcherRemediations(failureClass, watcherHost);

      // Then: non-empty and every entry is manual (never automatic).
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.kind).toBe("manual");
        expect(entry.kind).not.toBe("automatic");
      }
    }
  });

  test("puts a non-privileged action first without sysctl", () => {
    // Given: a watcher host label and all four failure classes.
    const watcherHost = "this Linux host";

    for (const failureClass of FAILURE_CLASSES) {
      // When: build remediations for the class.
      const entries = watcherRemediations(failureClass, watcherHost);
      const first = entries[0];

      // Then: first entry description and command contain no sysctl (case-insensitive).
      expect(first).toBeDefined();
      expect(first?.description.toLowerCase()).not.toContain("sysctl");
      expect(first?.command).toBe("lando global:restart");
    }
  });

  test("includes the watcherHost string in every remediation description", () => {
    // Given: a distinctive watcher host label and all four failure classes.
    const watcherHost = "this Linux host";

    for (const failureClass of FAILURE_CLASSES) {
      // When: build remediations for the class.
      const entries = watcherRemediations(failureClass, watcherHost);

      // Then: every description names the watcher host.
      for (const entry of entries) {
        expect(entry.description).toContain(watcherHost);
      }
    }
  });

  test("mentions sysctl and never for inotify-limit remediations", () => {
    // Given: inotify-limit on a Linux host.
    const watcherHost = "this Linux host";

    // When: build remediations for inotify-limit.
    const entries = watcherRemediations("inotify-limit", watcherHost);

    // Then: some entry mentions sysctl and the word never in that same description
    // (Lando never runs sysctl for you).
    const sysctlEntry = entries.find((entry) => /sysctl/i.test(entry.description));
    expect(sysctlEntry).toBeDefined();
    expect(sysctlEntry?.description.toLowerCase()).toContain("never");
  });
});
