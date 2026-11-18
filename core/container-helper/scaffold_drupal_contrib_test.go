package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const contribScaffoldCommand = "drupal-contrib-scaffold"
const contribVersionCommand = "drupal-contrib-core-version"
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

func contribStageCalls(f *scaffoldFixture) [][]string {
	stage := filepath.Join(f.appRoot, ".lando-scaffold", "drupal-contrib-scaffold")
	return [][]string{
		{"create-project", "--no-install", "--no-scripts", "--no-interaction", "drupal/recommended-project:^10 || ^11", stage},
		{"--working-dir=" + stage, "require", "--no-update", "--no-interaction", "drush/drush:*"},
		{"--working-dir=" + stage, "require", "--dev", "--no-update", "--no-interaction", "drupal/core-dev:^10 || ^11", "drupal/coder:*"},
	}
}

func TestDrupalContribRejectsInvalidArgs(t *testing.T) {
	for _, command := range []string{contribScaffoldCommand, contribVersionCommand} {
		t.Run(command, func(t *testing.T) {
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
				if code := f.run(t, command, tc.args...); code != 1 || !strings.Contains(f.stderr.String(), tc.message) {
					t.Fatalf("%s %q exited %d: %s, want %q", command, tc.args, code, f.stderr.String(), tc.message)
				}
			}
			assertContribCalls(t, f)
			assertDirectoryNames(t, f.appRoot, nil)
		})
	}
}

func TestDrupalContribScaffoldInstallsAroundMountAndMergesDeps(t *testing.T) {
	f := newContribFixture(t)
	const info = "name: Example\ntype: 'module' # required\n"
	mount := contribTestMount(t, f, "module", "example", info)
	source := filepath.Join(mount, "example.module")
	writeContribTestFile(t, source, "<?php // mounted source\n")
	const deps = `{
		"name":"drupal/example",
		"require":{"acme/use":"^2 || ^3","acme/root-dev":"^9","drush/drush":"^9","drupal/example":"*",
			"php":">=8.3","ext-json":"*","lib-curl":"*","composer-plugin-api":"*","composer-runtime-api":"*",
			"drupal/core":"^9","drupal/core-recommended":"^9","drupal/core-dev":"^9","drupal/core-composer-scaffold":"^9"},
		"require-dev":{"acme/test":"^3","acme/root":"^9","acme/use":"^9","drupal/coder":"^9","drupal/example":"*"},
		"repositories":[{"type":"path","url":"."}]
	}`
	writeContribTestFile(t, filepath.Join(mount, "composer.json"), deps)
	before, err := os.Stat(mount)
	if err != nil {
		t.Fatal(err)
	}
	if code := f.run(t, contribScaffoldCommand, "module", "example", contribTestConstraint); code != 0 {
		t.Fatalf("scaffold exited %d: %s", code, f.stderr.String())
	}
	stage := "--working-dir=" + filepath.Join(f.appRoot, ".lando-scaffold", "drupal-contrib-scaffold")
	want := append(contribStageCalls(f),
		[]string{stage, "require", "--no-update", "--no-interaction", "acme/use:^2 || ^3"},
		[]string{stage, "require", "--dev", "--no-update", "--no-interaction", "acme/test:^3"},
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
	assertFileText(t, filepath.Join(f.appRoot, ".lando-drupal-contrib-scaffold-complete"), "")
	if code := f.run(t, contribScaffoldCommand, "module", "example", contribTestConstraint); code != 1 ||
		!strings.Contains(f.stderr.String(), "Drupal contrib is already scaffolded at "+f.appRoot+".") {
		t.Fatalf("rerun exited %d: %s", code, f.stderr.String())
	}
	assertContribCalls(t, f, want...)
}

func TestDrupalContribScaffoldResumesInstall(t *testing.T) {
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
			f.kill(t, contribScaffoldCommand, tc.point, args...)
			if code := f.run(t, contribScaffoldCommand, args...); code != 0 {
				t.Fatalf("resume exited %d: %s", code, f.stderr.String())
			}
			want := contribStageCalls(f)
			for i := 0; i < tc.installs; i++ {
				want = append(want, []string{"install", "--no-interaction"})
			}
			assertContribCalls(t, f, want...)
			assertFileText(t, filepath.Join(f.appRoot, ".lando-drupal-contrib-scaffold-complete"), "")
			assertDirectoryNames(t, filepath.Join(f.appRoot, "web/sites/simpletest/browser_output"), nil)
		})
	}
}

func TestDrupalContribScaffoldRepairsOrphanMarker(t *testing.T) {
	f := newContribFixture(t)
	contribTestMount(t, f, "profile", "example", "type: profile\n")
	marker := filepath.Join(f.appRoot, ".lando-drupal-contrib-scaffold-complete")
	writeContribTestFile(t, marker, "orphan")
	if code := f.run(t, contribScaffoldCommand, "profile", "example", contribTestConstraint); code != 0 {
		t.Fatalf("repair exited %d: %s", code, f.stderr.String())
	}
	assertContribCalls(t, f, append(contribStageCalls(f), []string{"install", "--no-interaction"})...)
	assertFileText(t, marker, "")
}
