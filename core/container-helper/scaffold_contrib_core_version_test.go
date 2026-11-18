package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
		{"composer failure", "recipe:\n  options:\n    drupal: ^10 # keep\n", "fail-update"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newContribFixture(t)
			f.env["LANDO_TEST_COMPOSER_MODE"] = tc.mode
			mount := contribTestMount(t, f, "module", "example", "type: module\n")
			landofile := filepath.Join(mount, ".lando.yml")
			if tc.text != "" {
				writeContribTestFile(t, landofile, tc.text)
			}
			writeContribTestFile(t, filepath.Join(f.appRoot, "composer.json"), `{}`)
			code := f.run(t, contribVersionCommand, "module", "example", "^11")
			message := "Drupal core now uses ^11, but recipe.options.drupal in " + landofile + " could not be updated; set it there"
			if tc.mode != "" {
				message = "Composer could not update Drupal core"
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
