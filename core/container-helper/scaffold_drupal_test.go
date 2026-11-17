package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDrupalScaffoldStagesAndPromotes(t *testing.T) {
	fixture := newScaffoldFixture(t, map[string]string{"LANDO_TEST_COMPOSER_RECIPE": "drupal"})

	if code := fixture.run(t, "drupal-scaffold", "11"); code != 0 {
		t.Fatalf("drupal-scaffold exited %d: %s", code, fixture.stderr.String())
	}
	mustEqualStrings(t, fixture.calls(t), []string{"create-project", "require"})
	for _, path := range []string{"composer.json", "vendor/bin/drush", "web", ".lando-drupal-scaffold-complete"} {
		if !pathExists(filepath.Join(fixture.appRoot, filepath.FromSlash(path))) {
			t.Fatalf("missing %s", path)
		}
	}
	if pathExists(filepath.Join(fixture.appRoot, ".lando-drupal-scaffold-manifest")) {
		t.Fatal("completion left its manifest behind")
	}
}

func TestDrupalScaffoldMajorArgumentAndEnvironment(t *testing.T) {
	fixture := newScaffoldFixture(t, map[string]string{"LANDO_TEST_COMPOSER_RECIPE": "drupal"})
	if code := fixture.run(t, "drupal-scaffold", "10"); code != 0 {
		t.Fatalf("drupal-scaffold exited %d: %s", code, fixture.stderr.String())
	}
	if len(fixture.calls(t)) == 0 {
		t.Fatal("the major argument did not reach Composer")
	}

	other := newScaffoldFixture(t, map[string]string{
		"LANDO_TEST_COMPOSER_RECIPE": "drupal",
		"LANDO_DRUPAL_MAJOR":         "11",
	})
	if code := other.run(t, "drupal-scaffold"); code != 0 {
		t.Fatalf("environment major exited %d: %s", code, other.stderr.String())
	}

	for _, testCase := range [][]string{{}, {"eleven"}, {"10", "11"}} {
		invalid := newScaffoldFixture(t, map[string]string{"LANDO_TEST_COMPOSER_RECIPE": "drupal"})
		if code := invalid.run(t, "drupal-scaffold", testCase...); code == 0 {
			t.Fatalf("%v was accepted", testCase)
		}
	}
}

func TestDrupalScaffoldCompletionAndRepair(t *testing.T) {
	fixture := newScaffoldFixture(t, map[string]string{"LANDO_TEST_COMPOSER_RECIPE": "drupal"})
	if code := fixture.run(t, "drupal-scaffold", "11"); code != 0 {
		t.Fatalf("first run exited %d: %s", code, fixture.stderr.String())
	}

	if code := fixture.run(t, "drupal-scaffold", "11"); code == 0 {
		t.Fatal("a completed scaffold was run again")
	}
	if !strings.Contains(fixture.stderr.String(), "already scaffolded") {
		t.Fatalf("unexpected completion error: %s", fixture.stderr.String())
	}

	repair := newScaffoldFixture(t, map[string]string{"LANDO_TEST_COMPOSER_RECIPE": "drupal"})
	if err := os.WriteFile(filepath.Join(repair.appRoot, ".lando-drupal-scaffold-complete"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if code := repair.run(t, "drupal-scaffold", "11"); code != 0 {
		t.Fatalf("repair run exited %d: %s", code, repair.stderr.String())
	}
	if !pathExists(filepath.Join(repair.appRoot, "vendor", "bin", "drush")) {
		t.Fatal("repair did not restore the missing outputs")
	}
}

func TestDrupalScaffoldResumesWithoutRestaging(t *testing.T) {
	fixture := newScaffoldFixture(t, map[string]string{"LANDO_TEST_COMPOSER_RECIPE": "drupal"})
	fixture.kill(t, "drupal-scaffold", "sibling-promoted", "11")

	if code := fixture.run(t, "drupal-scaffold", "11"); code != 0 {
		t.Fatalf("resume exited %d: %s", code, fixture.stderr.String())
	}
	staged := 0
	for _, call := range fixture.calls(t) {
		if call == "create-project" {
			staged++
		}
	}
	if staged != 1 {
		t.Fatalf("resume restaged Drupal %d times", staged)
	}
}

func TestDrupalCmsScaffoldRunsThePinnedSequence(t *testing.T) {
	fixture := newScaffoldFixture(t, map[string]string{"LANDO_TEST_COMPOSER_RECIPE": "cms"})

	if code := fixture.run(t, "drupal-cms-scaffold"); code != 0 {
		t.Fatalf("drupal-cms-scaffold exited %d: %s", code, fixture.stderr.String())
	}
	mustEqualStrings(t, fixture.calls(t), []string{
		"create-project",
		"config",
		"require",
		"update",
		"audit",
		"install",
		"run-script post-update-cmd",
		"run-script post-create-project-cmd",
		"audit",
	})
	for _, path := range []string{
		"composer.json",
		"composer.lock",
		"vendor/bin/drush",
		"web",
		"recipes/drupal_cms_starter/recipe.yml",
		".lando-drupal-cms-scaffold-complete",
	} {
		if !pathExists(filepath.Join(fixture.appRoot, filepath.FromSlash(path))) {
			t.Fatalf("missing %s", path)
		}
	}
	if pathExists(filepath.Join(fixture.appRoot, ".lando-drupal-cms-scaffold-manifest")) {
		t.Fatal("completion left its manifest behind")
	}
}

func TestDrupalCmsScaffoldPublishesNothingWhenGenerationFails(t *testing.T) {
	for _, mode := range []string{"audit-fail", "install-fail", "repo-tamper", "lock-ref", "installed-dirty"} {
		t.Run(mode, func(t *testing.T) {
			fixture := newScaffoldFixture(t, map[string]string{
				"LANDO_TEST_COMPOSER_RECIPE": "cms",
				"LANDO_TEST_COMPOSER_MODE":   mode,
			})
			if err := os.WriteFile(filepath.Join(fixture.appRoot, "user.txt"), []byte("keep me\n"), 0o644); err != nil {
				t.Fatal(err)
			}

			if code := fixture.run(t, "drupal-cms-scaffold"); code == 0 {
				t.Fatalf("%s did not fail", mode)
			}
			assertDirectoryNames(t, fixture.appRoot, []string{"user.txt"})
			assertFileText(t, filepath.Join(fixture.appRoot, "user.txt"), "keep me\n")
		})
	}
}
