package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDrupalScaffoldReplaysUnpromotedJournal(t *testing.T) {
	fixture := newScaffoldFixture(t, map[string]string{"LANDO_TEST_COMPOSER_RECIPE": "drupal"})
	fixture.kill(t, "drupal-scaffold", "classified", "11", "web", "--testing=false")
	if code := fixture.run(t, "drupal-scaffold", "11", "docroot", "--testing=false"); code != 0 {
		t.Fatalf("could not replay staging: %s", fixture.stderr.String())
	}
	if !pathExists(filepath.Join(fixture.appRoot, "docroot", "index.php")) || pathExists(filepath.Join(fixture.appRoot, "web")) {
		t.Fatal("replayed scaffold did not use the new webroot")
	}
}

func TestDrupalScaffoldRetiresJournalAfterReceipt(t *testing.T) {
	fixture := newScaffoldFixture(t, map[string]string{"LANDO_TEST_COMPOSER_RECIPE": "drupal"})
	fixture.kill(t, "drupal-scaffold", "complete-marker", "11", "web", "--testing=false")
	calls := fixture.calls(t)
	if code := fixture.run(t, "drupal-scaffold", "11", "web", "--testing=false"); code != 0 {
		t.Fatalf("could not resume after receipt publication: %s", fixture.stderr.String())
	}
	if pathExists(filepath.Join(fixture.appRoot, ".lando-drupal-scaffold-manifest")) {
		t.Fatal("successful resume did not retire the journal")
	}
	mustEqualStrings(t, fixture.calls(t), calls)
}

func TestDrupalCmsScaffoldRequiresCompleteMovedSite(t *testing.T) {
	fixture := newScaffoldFixture(t, map[string]string{"LANDO_TEST_COMPOSER_RECIPE": "cms"})
	if code := fixture.run(t, "drupal-cms-scaffold", "web", "--testing=false"); code != 0 {
		t.Fatalf("first scaffold failed: %s", fixture.stderr.String())
	}
	calls := fixture.calls(t)
	if code := fixture.run(t, "drupal-cms-scaffold", "public/docroot", "--testing=false"); code == 0 || !strings.Contains(fixture.stderr.String(), "recipe.options.webroot") {
		t.Fatalf("unmoved site was accepted or lacked remediation: %s", fixture.stderr.String())
	}
	parent := filepath.Join(fixture.appRoot, "public")
	if err := os.Mkdir(parent, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(fixture.appRoot, "web"), filepath.Join(parent, "docroot")); err != nil {
		t.Fatal(err)
	}
	if code := fixture.run(t, "drupal-cms-scaffold", "/app/public/docroot", "--testing=false"); code != 0 {
		t.Fatalf("complete moved site was rejected: %s", fixture.stderr.String())
	}
	starter := "recipes/drupal_cms_starter/recipe.yml"
	if err := os.Remove(filepath.Join(fixture.appRoot, starter)); err != nil {
		t.Fatal(err)
	}
	if code := fixture.run(t, "drupal-cms-scaffold", "public/docroot", "--testing=false"); code == 0 || !strings.Contains(fixture.stderr.String(), starter) {
		t.Fatalf("moved site without the starter recipe was accepted: %s", fixture.stderr.String())
	}
	mustEqualStrings(t, fixture.calls(t), calls)
}

func TestDrupalScaffoldDoesNotChangeExistingDependencies(t *testing.T) {
	fixture := newScaffoldFixture(t, map[string]string{"LANDO_TEST_COMPOSER_RECIPE": "drupal"})
	if code := fixture.run(t, "drupal-scaffold", "11", "web", "--testing=false"); code != 0 {
		t.Fatalf("first scaffold failed: %s", fixture.stderr.String())
	}
	calls := fixture.calls(t)
	for _, args := range [][]string{{"10", "web", "--testing=false"}, {"11", "web", "--testing=true"}} {
		if code := fixture.run(t, "drupal-scaffold", args...); code != 0 || !strings.Contains(fixture.stdout.String(), "lando composer update") || strings.Count(fixture.stdout.String(), "\n") != 1 {
			t.Fatalf("dependency change did not report one notice: %s %s", fixture.stdout.String(), fixture.stderr.String())
		}
	}
	mustEqualStrings(t, fixture.calls(t), calls)
}

func TestDrupalScaffoldAdoptsBeforeWebrootValidation(t *testing.T) {
	for _, webroot := range []string{".", "public/site", "absolute"} {
		for _, composer := range []bool{false, true} {
			fixture := newScaffoldFixture(t, map[string]string{"LANDO_TEST_COMPOSER_RECIPE": "drupal"})
			configured := webroot
			root := filepath.Join(fixture.appRoot, webroot)
			if webroot == "absolute" {
				root = t.TempDir()
				configured = root
			}
			paths := []string{filepath.Join(fixture.appRoot, "composer.json")}
			if !composer {
				paths = []string{filepath.Join(root, "index.php"), filepath.Join(root, "core", "lib", "Drupal.php")}
			}
			for _, path := range paths {
				if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte("existing\n"), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.Mkdir(filepath.Join(fixture.appRoot, scaffoldLockName), 0o755); err != nil {
				t.Fatal(err)
			}
			if code := fixture.run(t, "drupal-scaffold", "11", configured, "--testing=false"); code != 0 || !strings.Contains(fixture.stdout.String(), "using the existing project") || len(fixture.calls(t)) != 0 {
				t.Fatalf("adoption failed for %q: %s", configured, fixture.stderr.String())
			}
			for _, path := range paths {
				assertFileText(t, path, "existing\n")
			}
		}
	}
}

func TestDrupalScaffoldAdoptsSiteWithEmptyLegacyMarker(t *testing.T) {
	fixture := newScaffoldFixture(t, map[string]string{"LANDO_TEST_COMPOSER_RECIPE": "drupal"})
	marker := filepath.Join(fixture.appRoot, ".lando-drupal-scaffold-complete")
	composer := filepath.Join(fixture.appRoot, "composer.json")
	for path, content := range map[string]string{marker: "", composer: "existing\n"} {
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if code := fixture.run(t, "drupal-scaffold", "11", "web", "--testing=false"); code != 0 || !strings.Contains(fixture.stdout.String(), "using the existing project") || len(fixture.calls(t)) != 0 {
		t.Fatalf("legacy marker blocked start: %s", fixture.stderr.String())
	}
	assertFileText(t, marker, "")
	assertFileText(t, composer, "existing\n")
}

func TestDrupalScaffoldRefusesMalformedOrUnreadableState(t *testing.T) {
	for _, name := range []string{".lando-drupal-scaffold-manifest", ".lando-drupal-scaffold-complete"} {
		for _, symlink := range []bool{false, true} {
			fixture := newScaffoldFixture(t, map[string]string{"LANDO_TEST_COMPOSER_RECIPE": "drupal"})
			path := filepath.Join(fixture.appRoot, name)
			var err error
			if symlink {
				err = os.Symlink("missing", path)
			} else {
				err = os.WriteFile(path, []byte("{"), 0o644)
			}
			if err != nil {
				t.Fatal(err)
			}
			if code := fixture.run(t, "drupal-scaffold", "11", "nested/web", "--testing=false"); code == 0 || !strings.Contains(fixture.stderr.String(), "scaffold") || strings.Contains(fixture.stderr.String(), "recipe.options.webroot") || len(fixture.calls(t)) != 0 {
				t.Fatalf("bad %s was ignored: %s", name, fixture.stderr.String())
			}
			assertDirectoryNames(t, fixture.appRoot, []string{name})
		}
	}
}
