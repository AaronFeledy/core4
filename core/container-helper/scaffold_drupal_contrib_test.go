package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const contribSyncCommand = "drupal-contrib-sync"
const contribTestConstraint = "^10 || ^11"

func newContribFixture(t *testing.T) *scaffoldFixture {
	t.Helper()
	return newScaffoldFixture(t, map[string]string{"LANDO_TEST_COMPOSER_RECIPE": "contrib"})
}

func contribTestMount(t *testing.T, fixture *scaffoldFixture, kind, infoName, info string) string {
	t.Helper()
	mount := filepath.Join(fixture.appRoot, "web", kind+"s", "custom", "example")
	if err := os.MkdirAll(mount, 0o755); err != nil {
		t.Fatal(err)
	}
	writeContribTestFile(t, filepath.Join(mount, infoName+".info.yml"), info)
	return mount
}

func writeContribTestFile(t *testing.T, path, text string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(text), 0o640); err != nil {
		t.Fatal(err)
	}
}

func assertContribCalls(t *testing.T, f *scaffoldFixture, argv ...[]string) {
	t.Helper()
	want := make([]string, 0, len(argv))
	for _, args := range argv {
		line, err := json.Marshal(args)
		if err != nil {
			t.Fatal(err)
		}
		want = append(want, string(line))
	}
	mustEqualStrings(t, f.calls(t), want)
}

func contribSetupCalls(f *scaffoldFixture) [][]string {
	stage := filepath.Join(f.appRoot, ".lando-scaffold", "drupal-contrib-sync")
	return [][]string{
		{"create-project", "--no-install", "--no-scripts", "--no-interaction", "drupal/recommended-project:^10 || ^11", stage},
		{"--working-dir=" + stage, "require", "--no-update", "--no-interaction", "drupal/core-composer-scaffold:^10 || ^11", "drupal/core-project-message:^10 || ^11", "drupal/core-recommended:^10 || ^11", "drush/drush:*"},
		{"--working-dir=" + stage, "require", "--dev", "--no-update", "--no-interaction", "drupal/coder:*", "drupal/core-dev:^10 || ^11"},
	}
}

func contribLockCall(f *scaffoldFixture) []string {
	stage := filepath.Join(f.appRoot, ".lando-scaffold", "drupal-contrib-sync")
	return []string{"--working-dir=" + stage, "update", "--no-install", "--no-scripts", "--no-plugins", "--no-interaction"}
}

// contribStageCalls is the staging sequence for an extension without Composer dependencies.
func contribStageCalls(f *scaffoldFixture) [][]string {
	return append(contribSetupCalls(f), contribLockCall(f))
}

func TestDrupalContribRejectsInvalidArgs(t *testing.T) {
	f := newContribFixture(t)
	for _, tc := range []struct {
		args    []string
		message string
	}{
		{nil, "Usage:"},
		{[]string{"module", "example"}, "Usage:"},
		{[]string{"module", "example", "^10", "extra"}, "Usage:"},
		{[]string{"--help"}, "does not accept the option"},
		{[]string{"module", "example", "-v10"}, "does not accept the option"},
		{[]string{"package", "example", "^10"}, "module, theme, or profile"},
		{[]string{"module", "../example", "^10"}, "machine name"},
		{[]string{"module", "Example", "^10"}, "machine name"},
		{[]string{"module", "example", ""}, "constraint is invalid"},
		{[]string{"module", "example", "^10;test"}, "constraint is invalid"},
	} {
		if code := f.run(t, contribSyncCommand, tc.args...); code != 1 || !strings.Contains(f.stderr.String(), tc.message) {
			t.Fatalf("%s %q exited %d: %s, want %q", contribSyncCommand, tc.args, code, f.stderr.String(), tc.message)
		}
	}
	assertContribCalls(t, f)
	assertDirectoryNames(t, f.appRoot, nil)
}

func TestDrupalContribSyncInstallsAroundMountAndMergesDeps(t *testing.T) {
	f := newContribFixture(t)
	const info = "name: Example\ntype: 'module' # required\n"
	mount := contribTestMount(t, f, "module", "example", info)
	source := filepath.Join(mount, "example.module")
	writeContribTestFile(t, source, "<?php // mounted source\n")
	const deps = `{
		"name":"drupal/example",
		"require":{"acme/use":"^2 || ^3","acme/root-dev":"^9","drush/drush":"^12","drupal/example":"*",
			"php":">=8.3","ext-json":"*","lib-curl":"*","composer-plugin-api":"*","composer-runtime-api":"*",
			"drupal/core":"^9","drupal/core-recommended":"^9","drupal/core-dev":"^9","drupal/core-composer-scaffold":"^9","drupal/core-project-message":"^9"},
		"require-dev":{"acme/test":"^3","acme/root":"^9","acme/use":"^9","drupal/coder":"^8.3","drupal/example":"*"},
		"repositories":[{"type":"path","url":"."}]
	}`
	writeContribTestFile(t, filepath.Join(mount, "composer.json"), deps)
	before, err := os.Stat(mount)
	if err != nil {
		t.Fatal(err)
	}
	if code := f.run(t, contribSyncCommand, "module", "example", contribTestConstraint); code != 0 {
		t.Fatalf("scaffold exited %d: %s", code, f.stderr.String())
	}
	site, err := readContribComposer(f.appRoot)
	if err != nil {
		t.Fatal(err)
	}
	if site.Require["drush/drush"] != "^12" || site.RequireDev["drupal/coder"] != "^8.3" {
		t.Fatalf("extension constraints lost: Drush = %q, Coder = %q", site.Require["drush/drush"], site.RequireDev["drupal/coder"])
	}
	if site.Require["acme/root"] != "^1" || site.RequireDev["acme/root-dev"] != "^1" {
		t.Fatalf("recommended project constraints changed: %v / %v", site.Require, site.RequireDev)
	}
	stage := "--working-dir=" + filepath.Join(f.appRoot, ".lando-scaffold", "drupal-contrib-sync")
	want := append(contribSetupCalls(f)[:1:1],
		[]string{stage, "require", "--no-update", "--no-interaction", "acme/use:^2 || ^3", "drupal/core-composer-scaffold:^10 || ^11", "drupal/core-project-message:^10 || ^11", "drupal/core-recommended:^10 || ^11", "drush/drush:^12"},
		[]string{stage, "require", "--dev", "--no-update", "--no-interaction", "acme/test:^3", "drupal/coder:^8.3", "drupal/core-dev:^10 || ^11"},
		contribLockCall(f),
		[]string{"install", "--no-interaction"})
	assertContribCalls(t, f, want...)
	after, err := os.Stat(mount)
	if err != nil || !os.SameFile(before, after) {
		t.Fatalf("mount directory was replaced: %v", err)
	}
	assertFileText(t, source, "<?php // mounted source\n")
	assertFileText(t, filepath.Join(mount, "example.info.yml"), info)
	assertFileText(t, filepath.Join(mount, "composer.json"), deps)
	assertFileText(t, filepath.Join(f.appRoot, "README.md"), "recommended project\n")
	manifest := readFakeJSON(filepath.Join(f.appRoot, "composer.json"))
	if _, exists := manifest["repositories"]; exists {
		t.Fatalf("unexpected repositories in the promoted manifest: %v", manifest)
	}
	for _, name := range []string{"drush", "phpunit", "phpcs"} {
		info, err := os.Stat(filepath.Join(f.appRoot, "vendor", "bin", name))
		if err != nil || !info.Mode().IsRegular() || info.Mode()&0o111 == 0 {
			t.Fatalf("missing executable %s: %v", name, err)
		}
	}
	assertFileText(t, filepath.Join(f.appRoot, "web", "index.php"), "<?php\n")
	for _, dir := range []string{"web/core", "web/sites/simpletest/browser_output", "web/sites/default/files/simpletest"} {
		assertDirectoryNames(t, filepath.Join(f.appRoot, dir), nil)
	}
	if !isRegularFile(filepath.Join(f.appRoot, ".lando-drupal-contrib-sync-complete")) {
		t.Fatal("sync did not mark the site complete")
	}
	record := loadContribSyncRecord(f.appRoot)
	if record.Version != 1 || record.Require["acme/use"] != "^2 || ^3" || record.RequireDev["acme/test"] != "^3" ||
		record.Require["acme/root-dev"] != "" || record.RequireDev["acme/root"] != "" {
		t.Fatalf("record should contain applied requirements only: %+v", record)
	}
	if code := f.run(t, contribSyncCommand, "module", "example", contribTestConstraint); code != 0 ||
		f.stdout.String() != "Drupal site at "+f.appRoot+" is up to date.\n" || f.stderr.Len() != 0 {
		t.Fatalf("rerun exited %d: %s", code, f.stderr.String())
	}
	assertContribCalls(t, f, want...)
}

func TestDrupalContribSyncResumesInstall(t *testing.T) {
	for _, tc := range []struct {
		point    string
		installs int
	}{
		{"during-contrib-install", 2}, {"hook-composer-install", 1},
	} {
		t.Run(tc.point, func(t *testing.T) {
			f := newContribFixture(t)
			contribTestMount(t, f, "theme", "example", "type: theme\n")
			args := []string{"theme", "example", contribTestConstraint}
			f.kill(t, contribSyncCommand, tc.point, args...)
			if code := f.run(t, contribSyncCommand, args...); code != 0 {
				t.Fatalf("resume exited %d: %s", code, f.stderr.String())
			}
			want := contribStageCalls(f)
			for i := 0; i < tc.installs; i++ {
				want = append(want, []string{"install", "--no-interaction"})
			}
			assertContribCalls(t, f, want...)
			assertFileText(t, filepath.Join(f.appRoot, ".lando-drupal-contrib-sync-complete"), "")
			assertDirectoryNames(t, filepath.Join(f.appRoot, "web/sites/simpletest/browser_output"), nil)
		})
	}
}

func TestDrupalContribSyncRepairsOrphanMarker(t *testing.T) {
	f := newContribFixture(t)
	contribTestMount(t, f, "profile", "example", "type: profile\n")
	marker := filepath.Join(f.appRoot, ".lando-drupal-contrib-sync-complete")
	writeContribTestFile(t, marker, "orphan")
	if code := f.run(t, contribSyncCommand, "profile", "example", contribTestConstraint); code != 0 {
		t.Fatalf("repair exited %d: %s", code, f.stderr.String())
	}
	assertContribCalls(t, f, append(contribStageCalls(f), []string{"install", "--no-interaction"})...)
	assertFileText(t, marker, "")
}
