package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDrupalContribSyncPreflightRemediation(t *testing.T) {
	// The remediation must name the path or option to fix and the commands to run next.
	for _, tc := range []struct {
		name, infoName, info string
		want                 []string
	}{
		{"missing mount", "", "", []string{"%s", "lando restart", "lando drupal-contrib-sync"}},
		{"project mismatch", "actual", "type: module\n", []string{"recipe.options.project", "actual", "lando restart", "lando drupal-contrib-sync"}},
		{"type mismatch", "example", "extra:\n  type: module\ntype: theme\n", []string{"recipe.options.type", "theme", "lando restart", "lando drupal-contrib-sync"}},
		{"missing top-level type", "example", "extra:\n  type: module\n", []string{"recipe.options.type", "lando drupal-contrib-sync"}},
		{"multiple info files", "example", "type: module\n", []string{"%s", "*.info.yml", "lando drupal-contrib-sync"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newContribFixture(t)
			mount := filepath.Join(f.appRoot, "web", "modules", "custom", "example")
			if tc.infoName != "" {
				contribTestMount(t, f, "module", tc.infoName, tc.info)
			}
			if tc.name == "multiple info files" {
				writeContribTestFile(t, filepath.Join(mount, "second.info.yml"), "type: module\n")
			}
			code := f.run(t, contribSyncCommand, "module", "example", "^11")
			stderr := f.stderr.String()
			if code != 1 || strings.Contains(strings.ToLower(stderr), "re-init") {
				t.Fatalf("preflight exited %d: %s", code, stderr)
			}
			for _, part := range tc.want {
				if part = strings.Replace(part, "%s", mount, 1); !strings.Contains(stderr, part) {
					t.Fatalf("preflight remediation %q does not name %q", stderr, part)
				}
			}
			assertContribCalls(t, f)
			if tc.infoName == "" {
				assertDirectoryNames(t, f.appRoot, nil)
			} else {
				assertDirectoryNames(t, f.appRoot, []string{"web"})
			}
		})
	}
}

func TestDrupalContribSyncDoesNotMarkIncompleteInstall(t *testing.T) {
	for _, tc := range []struct{ name, mode, want string }{
		{"missing staged manifest", "missing-stage-json", "did not stage a composer.json"},
		{"nonexecutable PHPUnit", "phpunit", "did not produce"},
		{"nonexecutable PHPCS", "phpcs", "did not produce"},
		{"duplicate extension", "", "installed the extension into contrib"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newContribFixture(t)
			f.env["LANDO_TEST_COMPOSER_MODE"] = tc.mode
			contribTestMount(t, f, "module", "example", "type: module\n")
			if tc.mode == "" {
				if err := os.MkdirAll(filepath.Join(f.appRoot, "web", "modules", "contrib", "example"), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			code := f.run(t, contribSyncCommand, "module", "example", contribTestConstraint)
			if code != 1 || !strings.Contains(f.stderr.String(), tc.want) {
				t.Fatalf("scaffold exited %d: %s, want %q", code, f.stderr.String(), tc.want)
			}
			if _, err := os.Lstat(filepath.Join(f.appRoot, ".lando-drupal-contrib-sync-complete")); !os.IsNotExist(err) {
				t.Fatalf("incomplete scaffold published a marker: %v", err)
			}
		})
	}
}

func TestDrupalContribSyncPublishesNothingWhenResolutionFails(t *testing.T) {
	f := newContribFixture(t)
	f.env["LANDO_TEST_COMPOSER_MODE"] = "fail-update"
	contribTestMount(t, f, "module", "example", "type: module\n")
	code := f.run(t, contribSyncCommand, "module", "example", contribTestConstraint)
	if code != 1 || !strings.Contains(f.stderr.String(), "Composer update (resolve the site dependencies) failed; fix the Composer error, then rerun lando drupal-contrib-sync") {
		t.Fatalf("scaffold exited %d: %s", code, f.stderr.String())
	}
	assertContribCalls(t, f, contribStageCalls(f)...)
	assertDirectoryNames(t, f.appRoot, []string{"web"})
}
