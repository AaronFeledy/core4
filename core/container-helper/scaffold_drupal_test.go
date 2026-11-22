package main

import (
	"encoding/json"
	"maps"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDrupalScaffoldStagesAndPromotes(t *testing.T) {
	fixture := newScaffoldFixture(t, map[string]string{"LANDO_TEST_COMPOSER_RECIPE": "drupal"})

	if code := fixture.run(t, "drupal-scaffold", "11", "/app/docroot", "--testing=false"); code != 0 {
		t.Fatalf("drupal-scaffold exited %d: %s", code, fixture.stderr.String())
	}
	for _, path := range []string{"composer.json", "vendor/bin/drush", "docroot/index.php", "docroot/core", ".lando-drupal-scaffold-complete"} {
		if !pathExists(filepath.Join(fixture.appRoot, filepath.FromSlash(path))) {
			t.Fatalf("missing %s", path)
		}
	}
	data, err := os.ReadFile(filepath.Join(fixture.appRoot,"phpstan.neon.dist"))
	if err != nil || !strings.Contains(string(data),"docroot/modules") { t.Fatalf("PHPStan config did not follow docroot: %s (%v)", data,err) }
	if pathExists(filepath.Join(fixture.appRoot, ".lando-drupal-scaffold-manifest")) {
		t.Fatal("completion left its manifest behind")
	}
}

func TestDrupalScaffoldRejectsInvalidArgumentsBeforeComposer(t *testing.T) {
	fixture := newScaffoldFixture(t, map[string]string{"LANDO_TEST_COMPOSER_RECIPE": "drupal"})
	if code := fixture.run(t, "drupal-scaffold", "10", "web", "--testing=false"); code != 0 {
		t.Fatalf("drupal-scaffold exited %d: %s", code, fixture.stderr.String())
	}
	if len(fixture.calls(t)) == 0 {
		t.Fatal("the major argument did not reach Composer")
	}

	for _, testCase := range [][]string{{}, {"eleven"}, {"10", "11"}, {"11","public/site","--testing=false"}, {"11","vendor","--testing=false"}} {
		invalid := newScaffoldFixture(t, map[string]string{"LANDO_TEST_COMPOSER_RECIPE": "drupal"})
		if code := invalid.run(t, "drupal-scaffold", testCase...); code == 0 {
			t.Fatalf("%v was accepted", testCase)
		}
		if pathExists(filepath.Join(invalid.appRoot,scaffoldLockName)) || pathExists(filepath.Join(invalid.appRoot,scaffoldStageRoot)) { t.Fatalf("invalid argv %v mutated the project",testCase) }
	}
}

func TestDrupalScaffoldCompletionAndRepair(t *testing.T) {
	fixture := newScaffoldFixture(t, map[string]string{"LANDO_TEST_COMPOSER_RECIPE": "drupal"})
	if code := fixture.run(t, "drupal-scaffold", "11", "web", "--testing=false"); code != 0 {
		t.Fatalf("first run exited %d: %s", code, fixture.stderr.String())
	}

	for _, path := range []string{"phpcs.xml.dist", "phpstan.neon.dist", "vendor/bin/phpcs", "vendor/bin/phpcbf", "vendor/bin/phpstan"} {
		if err := os.Remove(filepath.Join(fixture.appRoot, path)); err != nil {
			t.Fatal(err)
		}
	}
	callsBeforeRetry := fixture.calls(t)
	if code := fixture.run(t, "drupal-scaffold", "11", "web", "--testing=false"); code == 0 {
		t.Fatal("a completed scaffold was run again")
	}
	if !strings.Contains(fixture.stderr.String(), "already scaffolded") {
		t.Fatalf("unexpected completion error: %s", fixture.stderr.String())
	}
	mustEqualStrings(t, fixture.calls(t), callsBeforeRetry)

	repair := newScaffoldFixture(t, map[string]string{"LANDO_TEST_COMPOSER_RECIPE": "drupal"})
	if err := os.WriteFile(filepath.Join(repair.appRoot, ".lando-drupal-scaffold-complete"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if code := repair.run(t, "drupal-scaffold", "11", "web", "--testing=false"); code != 0 {
		t.Fatalf("repair run exited %d: %s", code, repair.stderr.String())
	}
	if !pathExists(filepath.Join(repair.appRoot, "vendor", "bin", "drush")) {
		t.Fatal("repair did not restore the missing outputs")
	}
}

func TestDrupalScaffoldResumesWithoutRestaging(t *testing.T) {
	fixture := newScaffoldFixture(t, map[string]string{"LANDO_TEST_COMPOSER_RECIPE": "drupal"})
	fixture.kill(t, "drupal-scaffold", "sibling-promoted", "11", "web", "--testing=false")
	if code := fixture.run(t,"drupal-scaffold","11","docroot","--testing=false"); code == 0 || !strings.Contains(fixture.stderr.String(),`resume with webroot "web"`) { t.Fatalf("changed intent did not preserve the interrupted promotion: %s",fixture.stderr.String()) }

	if code := fixture.run(t, "drupal-scaffold", "11", "web", "--testing=false"); code != 0 {
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

	if code := fixture.run(t, "drupal-cms-scaffold", "docroot", "--testing=false"); code != 0 {
		t.Fatalf("drupal-cms-scaffold exited %d: %s", code, fixture.stderr.String())
	}
	mustEqualStrings(t, fixture.calls(t), []string{
		"create-project",
		"config --no-plugins allow-plugins.dealerdirect/phpcodesniffer-composer-installer true",
		"config --no-plugins allow-plugins.phpstan/extension-installer true",
		"config",
		"require --no-update drupal/svg_image:3.x-dev enshrined/svg-sanitize:^1.0 drupal/drupal_cms_starter:^2",
		"require --dev --no-update " + lintPackageArguments,
		"update",
		"audit",
		"install",
		"run-script post-create-project-cmd",
		"audit",
	})
	assertFileText(t, filepath.Join(fixture.appRoot, "phpcs.xml.dist"), strings.ReplaceAll(drupalPHPCSConfig, "web/", "docroot/"))
	assertFileText(t, filepath.Join(fixture.appRoot, "phpstan.neon.dist"), strings.ReplaceAll(drupalPHPStanConfig, "web/", "docroot/"))
	for _, bin := range []string{"drush", "phpcs", "phpcbf", "phpstan"} {
		if !executableFile(filepath.Join(fixture.appRoot, "vendor", "bin", bin)) {
			t.Fatalf("missing executable %s", bin)
		}
	}
	data, err := os.ReadFile(filepath.Join(fixture.appRoot, "composer.json"))
	if err != nil {
		t.Fatal(err)
	}
	var project struct {
		Config struct {
			AllowPlugins map[string]bool `json:"allow-plugins"`
		} `json:"config"`
	}
	if err := json.Unmarshal(data, &project); err != nil {
		t.Fatal(err)
	}
	wantPlugins := map[string]bool{
		"composer/installers":                            true,
		"dealerdirect/phpcodesniffer-composer-installer": true,
		"phpstan/extension-installer":                    true,
	}
	if !maps.Equal(project.Config.AllowPlugins, wantPlugins) {
		t.Fatalf("promoted allow-plugins = %v, want %v", project.Config.AllowPlugins, wantPlugins)
	}
	for _, path := range []string{
		"composer.json",
		"composer.lock",
		"vendor/bin/drush",
		"docroot/index.php",
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
	assertFileText(t, filepath.Join(fixture.appRoot, "docroot", "early.txt"), "early\n")
	for _, path := range []string{"web", "vendor/bin/composer"} {
		if pathExists(filepath.Join(fixture.appRoot, filepath.FromSlash(path))) {
			t.Fatalf("unexpected staged output %s was published", path)
		}
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

			if code := fixture.run(t, "drupal-cms-scaffold", "web", "--testing=false"); code == 0 {
				t.Fatalf("%s did not fail", mode)
			}
			assertDirectoryNames(t, fixture.appRoot, []string{"user.txt"})
			assertFileText(t, filepath.Join(fixture.appRoot, "user.txt"), "keep me\n")
		})
	}
}
