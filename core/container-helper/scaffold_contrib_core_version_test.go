package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func scaffoldContribForCoreVersion(t *testing.T, f *scaffoldFixture, kind string) {
	t.Helper()
	if code := f.run(t, contribScaffoldCommand, kind, "example", "^10"); code != 0 {
		t.Fatalf("could not prepare completed scaffold: %s", f.stderr.String())
	}
	if err := os.Remove(f.logPath); err != nil {
		t.Fatal(err)
	}
}

func TestDrupalContribCoreVersionUpdatesComposerThenOnlyRecipeValue(t *testing.T) {
	for _, tc := range []struct {
		name, require string
		optional      []string
	}{
		{"both", `"drupal/core-composer-scaffold":"^10","drupal/core-project-message":"^10"`, []string{"drupal/core-composer-scaffold", "drupal/core-project-message"}},
		{"only project message", `"drupal/core-project-message":"^10"`, []string{"drupal/core-project-message"}},
		{"neither", `"drupal/core-recommended":"^10"`, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newContribFixture(t)
			mount := contribTestMount(t, f, "profile", "example", "type: profile\n")
			landofile := filepath.Join(mount, ".lando.yml")
			const before = "--- # generated\r\nservices:\r\n  drupal: # service\r\n    type: php\r\n    script: |\r\n      ---\r\nrecipe: # recipe\r\n  id: drupal-contrib\r\n  options:\r\n    deeper:\r\n      drupal: keep me\r\n    \"drupal\":  '^10 # old'  # keep comment\r\n    type: profile\r\n# no final newline"
			writeContribTestFile(t, landofile, before)
			scaffoldContribForCoreVersion(t, f, "profile")
			writeContribTestFile(t, filepath.Join(f.appRoot, "composer.json"), `{"require":{`+tc.require+`}}`)
			if code := f.run(t, contribVersionCommand, "profile", "example", contribTestConstraint); code != 0 {
				t.Fatalf("core-version exited %d: %s", code, f.stderr.String())
			}
			wd := "--working-dir=" + f.appRoot
			require := []string{wd, "require", "--no-update", "--no-interaction", "drupal/core-recommended:^10 || ^11"}
			for _, name := range tc.optional {
				require = append(require, name+":^10 || ^11")
			}
			update := append([]string{wd, "update", "--with-all-dependencies", "--no-interaction", "drupal/core-recommended"}, tc.optional...)
			assertContribCalls(t, f, require,
				[]string{wd, "require", "--dev", "--no-update", "--no-interaction", "drupal/core-dev:^10 || ^11"},
				append(update, "drupal/core-dev", "drush/drush"))
			assertFileText(t, landofile, strings.Replace(before, "'^10 # old'", `"^10 || ^11"`, 1))
			info, err := os.Stat(landofile)
			if err != nil || info.Mode().Perm() != 0o640 {
				t.Fatalf("Landofile mode was not preserved: %v, %v", info, err)
			}
		})
	}
}

func TestDrupalContribCoreVersionLeavesLandofileUntouchedOnFailure(t *testing.T) {
	for _, tc := range []struct{ name, text, mode string }{
		{"missing key", "services:\n  drupal: unrelated\nrecipe:\n  options:\n    nested:\n      drupal: ^10\n    type: module\n", ""},
		{"missing file", "", ""},
		{"unsupported mapping", "recipe:\n  options: {drupal: '^10'}\n", ""},
		{"composer failure", "recipe:\n  options:\n    drupal: ^10 # keep\n", "fail-update"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newContribFixture(t)
			mount := contribTestMount(t, f, "module", "example", "type: module\n")
			scaffoldContribForCoreVersion(t, f, "module")
			f.env["LANDO_TEST_COMPOSER_MODE"] = tc.mode
			landofile := filepath.Join(mount, ".lando.yml")
			if tc.text != "" {
				writeContribTestFile(t, landofile, tc.text)
			}
			code := f.run(t, contribVersionCommand, "module", "example", "^11")
			message := "recipe.options.drupal in " + landofile + " could not be updated; set it there"
			if tc.mode != "" {
				message = "Composer could not update Drupal core"
			} else {
				assertContribCalls(t, f)
			}
			if code != 1 || !strings.Contains(f.stderr.String(), message) {
				t.Fatalf("core-version exited %d: %s", code, f.stderr.String())
			}
			if tc.text != "" {
				assertFileText(t, landofile, tc.text)
			} else if _, err := os.Lstat(landofile); !os.IsNotExist(err) {
				t.Fatalf("missing Landofile was created: %v", err)
			}
		})
	}
}

func TestDrupalContribCoreVersionUsesLandofileAfterComposer(t *testing.T) {
	for _, tc := range []struct {
		name, edited, want string
	}{
		{"preserve intervening edits", "name: edited\nrecipe:\n  options:\n    drupal: # keep\n", "name: edited\nrecipe:\n  options:\n    drupal: \"\\u003c12\" # keep\n"},
		{"refuse newly unsupported mapping", "recipe:\n  options: {drupal: '^10'}\n", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newContribFixture(t)
			mount := contribTestMount(t, f, "module", "example", "type: module\n")
			landofile := filepath.Join(mount, ".lando.yml")
			writeContribTestFile(t, landofile, "recipe:\n  options:\n    drupal: ^10\n")
			scaffoldContribForCoreVersion(t, f, "module")
			f.env["LANDO_TEST_EDIT_LANDOFILE"] = landofile
			f.env["LANDO_TEST_LANDOFILE_TEXT"] = tc.edited
			code := f.run(t, contribVersionCommand, "module", "example", "<12")
			if tc.want == "" {
				if code != 1 || !strings.Contains(f.stderr.String(), "Drupal core now uses <12, but recipe.options.drupal") {
					t.Fatalf("core-version exited %d: %s", code, f.stderr.String())
				}
				assertFileText(t, landofile, tc.edited)
				return
			}
			if code != 0 {
				t.Fatalf("core-version exited %d: %s", code, f.stderr.String())
			}
			assertFileText(t, landofile, tc.want)
		})
	}
}

func TestDrupalContribCoreVersionRejectsUnfinishedScaffold(t *testing.T) {
	for _, state := range []string{"promoted", "hook-composer-install", "missing executable"} {
		t.Run(state, func(t *testing.T) {
			f := newContribFixture(t)
			mount := contribTestMount(t, f, "module", "example", "type: module\n")
			landofile := filepath.Join(mount, ".lando.yml")
			const before = "recipe:\n  options:\n    drupal: ^10\n"
			writeContribTestFile(t, landofile, before)
			if state == "missing executable" {
				scaffoldContribForCoreVersion(t, f, "module")
				if err := os.Remove(filepath.Join(f.appRoot, "vendor", "bin", "phpunit")); err != nil {
					t.Fatal(err)
				}
			} else {
				f.kill(t, contribScaffoldCommand, state, "module", "example", "^10")
			}
			calls := f.calls(t)
			code := f.run(t, contribVersionCommand, "module", "example", "^11")
			mustEqualStrings(t, f.calls(t), calls)
			want := "Drupal contrib is not fully scaffolded at " + f.appRoot + ". Run lando drupal-contrib-scaffold first."
			if code != 1 || !strings.Contains(f.stderr.String(), want) {
				t.Fatalf("core-version exited %d: %s, want %q", code, f.stderr.String(), want)
			}
			assertFileText(t, landofile, before)
		})
	}
}

func TestDrupalContribCoreVersionRequiresScaffoldAndUsesItsLock(t *testing.T) {
	f := newContribFixture(t)
	if code := f.run(t, contribVersionCommand, "module", "example", "^11"); code != 1 ||
		!strings.Contains(f.stderr.String(), "Run lando drupal-contrib-scaffold first.") {
		t.Fatalf("unscaffolded core-version exited %d: %s", code, f.stderr.String())
	}
	writeContribTestFile(t, filepath.Join(f.appRoot, "composer.json"), `{}`)
	lock, err := acquireScaffoldLock(f.appRoot)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.release()
	if code := f.run(t, contribVersionCommand, "module", "example", "^11"); code != 1 ||
		!strings.Contains(f.stderr.String(), "Another Lando scaffold is already running") {
		t.Fatalf("locked core-version exited %d: %s", code, f.stderr.String())
	}
	assertContribCalls(t, f)
}
