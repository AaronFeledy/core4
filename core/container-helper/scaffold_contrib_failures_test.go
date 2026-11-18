package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDrupalContribScaffoldPreflightRemediation(t *testing.T) {
	for _, tc := range []struct{ name, infoName, info, want string }{
		{"missing mount", "", "", "is not mounted at %s. Run lando restart so the app mount is recreated"},
		{"project mismatch", "actual", "type: module\n", "Set recipe.options.project to actual in .lando.yml, run lando restart, then rerun lando drupal-contrib-scaffold"},
		{"type mismatch", "example", "extra:\n  type: module\ntype: theme\n", "Set recipe.options.type to theme in .lando.yml, run lando restart, then rerun lando drupal-contrib-scaffold"},
		{"missing top-level type", "example", "extra:\n  type: module\n", "must declare a top-level type"},
		{"multiple info files", "example", "type: module\n", "Expected exactly one *.info.yml"},
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
			code := f.run(t, contribScaffoldCommand, "module", "example", "^11")
			want := strings.Replace(tc.want, "%s", mount, 1)
			if code != 1 || !strings.Contains(f.stderr.String(), want) || strings.Contains(strings.ToLower(f.stderr.String()), "re-init") {
				t.Fatalf("preflight exited %d: %s, want %q", code, f.stderr.String(), want)
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

func TestDrupalContribScaffoldDoesNotMarkIncompleteInstall(t *testing.T) {
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
			code := f.run(t, contribScaffoldCommand, "module", "example", contribTestConstraint)
			if code != 1 || !strings.Contains(f.stderr.String(), tc.want) {
				t.Fatalf("scaffold exited %d: %s, want %q", code, f.stderr.String(), tc.want)
			}
			if _, err := os.Lstat(filepath.Join(f.appRoot, ".lando-drupal-contrib-scaffold-complete")); !os.IsNotExist(err) {
				t.Fatalf("incomplete scaffold published a marker: %v", err)
			}
		})
	}
}

func TestDrupalContribScaffoldPublishesNothingWhenResolutionFails(t *testing.T) {
	f := newContribFixture(t)
	f.env["LANDO_TEST_COMPOSER_MODE"] = "fail-update"
	contribTestMount(t, f, "module", "example", "type: module\n")
	code := f.run(t, contribScaffoldCommand, "module", "example", contribTestConstraint)
	if code != 1 || !strings.Contains(f.stderr.String(), "could not resolve the site dependencies") {
		t.Fatalf("scaffold exited %d: %s", code, f.stderr.String())
	}
	assertContribCalls(t, f, contribStageCalls(f)...)
	assertDirectoryNames(t, f.appRoot, []string{"web"})
}
