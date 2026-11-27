package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const lintPackageArguments = "drupal/coder:^8.3 || ^9.0 phpstan/phpstan:^1.12 || ^2.0 mglaman/phpstan-drupal:^1.2 || ^2.0 phpstan/extension-installer:^1.4"

func assertDrupalLintOutputs(t *testing.T, root string) {
	t.Helper()
	for _, name := range []string{"drush", "phpcs", "phpcbf", "phpstan"} {
		path := filepath.Join(root, "vendor", "bin", name)
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
			t.Fatalf("expected executable %s, stat error: %v", path, err)
		}
	}
	assertFileText(t, filepath.Join(root, "phpcs.xml.dist"), drupalPHPCSConfig)
	assertFileText(t, filepath.Join(root, "phpstan.neon.dist"), drupalPHPStanConfig)
}

func TestDrupalScaffoldKeepsProjectAndUserLintConfigs(t *testing.T) {
	fixture := newScaffoldFixture(t, map[string]string{
		"LANDO_TEST_COMPOSER_RECIPE": "drupal",
		"LANDO_TEST_COMPOSER_MODE":   "staged-config",
	})
	phpstan := filepath.Join(fixture.appRoot, "phpstan.neon.dist")
	if err := os.WriteFile(phpstan, []byte("user rules\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if code := fixture.run(t, "drupal-scaffold", "11", "web", "--testing=false"); code != 0 {
		t.Fatalf("drupal-scaffold exited %d: %s", code, fixture.stderr.String())
	}

	assertFileText(t, filepath.Join(fixture.appRoot, "phpcs.xml.dist"), "project rules\n")
	assertFileText(t, phpstan, "user rules\n")
}

func TestDrupalScaffoldsRefuseToPromoteNonexecutableLintTool(t *testing.T) {
	for _, recipe := range []struct {
		name, command string
		args          []string
	}{
		{"drupal", "drupal-scaffold", []string{"11", "web", "--testing=false"}},
		{"cms", "drupal-cms-scaffold", []string{"web", "--testing=false"}},
	} {
		t.Run(recipe.name, func(t *testing.T) {
			fixture := newScaffoldFixture(t, map[string]string{
				"LANDO_TEST_COMPOSER_RECIPE": recipe.name,
				"LANDO_TEST_COMPOSER_MODE":   "nonexecutable-phpcbf",
			})

			if code := fixture.run(t, recipe.command, recipe.args...); code == 0 {
				t.Fatal("scaffold accepted a nonexecutable phpcbf")
			}

			if !strings.Contains(fixture.stderr.String(), "did not stage vendor/bin/phpcbf") {
				t.Fatalf("unexpected failure: %s", fixture.stderr.String())
			}
			assertDirectoryNames(t, fixture.appRoot, nil)
		})
	}
}
