package main

import (
	"maps"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func completedContrib(t *testing.T, extension string) (*scaffoldFixture, string) {
	t.Helper()
	f := newContribFixture(t)
	mount := contribTestMount(t, f, "module", "example", "type: module\n")
	path := filepath.Join(mount, "composer.json")
	writeContribTestFile(t, path, extension)
	runContribSync(t, f, "^11")
	clearContribCalls(t, f)
	return f, path
}

func runContribSync(t *testing.T, f *scaffoldFixture, constraint string) {
	t.Helper()
	if code := f.run(t, contribSyncCommand, "module", "example", constraint); code != 0 {
		t.Fatalf("sync exited %d: %s", code, f.stderr.String())
	}
}

func clearContribCalls(t *testing.T, f *scaffoldFixture) {
	t.Helper()
	if err := os.Remove(f.logPath); err != nil {
		t.Fatal(err)
	}
}

func TestDrupalContribSyncChangesCoreConstraint(t *testing.T) {
	for _, mode := range []string{"success", "fail-update"} {
		t.Run(mode, func(t *testing.T) {
			f, _ := completedContrib(t, `{}`)
			dir := filepath.Join(f.appRoot, "web", "sites", "default")
			if err := os.Chmod(dir, 0o555); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.Chmod(dir, 0o755) })
			record := filepath.Join(f.appRoot, ".lando-drupal-contrib-sync.json")
			before, err := os.ReadFile(record)
			if err != nil {
				t.Fatal(err)
			}
			wd := "--working-dir=" + f.appRoot
			prod := []string{wd, "require", "--no-update", "--no-interaction", "drupal/core-composer-scaffold:^10", "drupal/core-project-message:^10", "drupal/core-recommended:^10"}
			dev := []string{wd, "require", "--dev", "--no-update", "--no-interaction", "drupal/core-dev:^10"}
			update := []string{wd, "update", "--with-all-dependencies", "--no-interaction", "drupal/core-composer-scaffold", "drupal/core-dev", "drupal/core-project-message", "drupal/core-recommended"}
			if mode == "fail-update" {
				f.env["LANDO_TEST_COMPOSER_MODE"] = mode
				code := f.run(t, contribSyncCommand, "module", "example", "^10")
				if code != 1 || !strings.Contains(f.stderr.String(), "Composer update failed; fix the Composer error, then rerun lando drupal-contrib-sync: exit status 42") {
					t.Fatalf("sync exited %d: %s", code, f.stderr.String())
				}
				assertContribCalls(t, f, prod, dev, update)
				assertFileText(t, record, string(before))
				assertContribSiteMode(t, dir)
				clearContribCalls(t, f)
				delete(f.env, "LANDO_TEST_COMPOSER_MODE")
				runContribSync(t, f, "^10")
				assertContribCalls(t, f, update)
			} else {
				runContribSync(t, f, "^10")
				assertContribCalls(t, f, prod, dev, update)
			}
			assertContribSiteMode(t, dir)
			want := `{"version":1,"require":{"drupal/core-composer-scaffold":"^10","drupal/core-project-message":"^10","drupal/core-recommended":"^10","drush/drush":"*"},"requireDev":{"drupal/coder":"*","drupal/core-dev":"^10"}}` + "\n"
			assertFileText(t, record, want)
		})
	}
}

func assertContribSiteMode(t *testing.T, dir string) {
	t.Helper()
	info, err := os.Stat(dir)
	if err != nil || info.Mode().Perm() != 0o555 {
		t.Fatalf("sites/default mode was not restored: %v, %v", info, err)
	}
}

func TestDrupalContribSyncAddsDropsAndMovesOnlyManagedDependencies(t *testing.T) {
	for _, tc := range []struct {
		name, before, after string
		edit                []string
		prod, dev           string
	}{
		{"add", `{}`, `{"require":{"acme/module":"^2"}}`, []string{"require", "--no-update", "--no-interaction", "acme/module:^2"}, "^2", ""},
		{"drop", `{"require-dev":{"acme/module":"^2"}}`, `{}`, []string{"remove", "--dev", "--no-update", "--no-interaction", "acme/module"}, "", ""},
		{"move", `{"require":{"acme/module":"^2"}}`, `{"require-dev":{"acme/module":"^2"}}`, []string{"require", "--dev", "--no-update", "--no-interaction", "acme/module:^2"}, "", "^2"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, extension := completedContrib(t, tc.before)
			path := filepath.Join(f.appRoot, "composer.json")
			manifest := readFakeJSON(path)
			manifest["require"].(map[string]any)["acme/user"] = "^4"
			writeFakeJSON(path, manifest)
			writeContribTestFile(t, extension, tc.after)

			runContribSync(t, f, "^11")

			wd := "--working-dir=" + f.appRoot
			assertContribCalls(t, f, append([]string{wd}, tc.edit...), []string{wd, "update", "--with-all-dependencies", "--no-interaction", "acme/module"})
			site, err := readContribComposer(f.appRoot)
			if err != nil || site.Require["acme/module"] != tc.prod || site.RequireDev["acme/module"] != tc.dev || site.Require["acme/user"] != "^4" {
				t.Fatalf("unexpected site requirements: %+v (%v)", site, err)
			}
		})
	}
}

func TestDrupalContribSyncInstallsMissingVendor(t *testing.T) {
	f, _ := completedContrib(t, `{}`)
	if err := os.RemoveAll(filepath.Join(f.appRoot, "vendor")); err != nil {
		t.Fatal(err)
	}
	runContribSync(t, f, "^11")
	assertContribCalls(t, f, []string{"--working-dir=" + f.appRoot, "install", "--no-interaction"})
	if !drupalContribComplete(f.appRoot) {
		t.Fatal("site is still incomplete after repairing vendor")
	}
}

func TestDrupalContribSyncPreservesInheritedDependencyWhenExtensionDropsIt(t *testing.T) {
	f, extension := completedContrib(t, `{"require":{"acme/root":"^9"}}`)
	writeContribTestFile(t, extension, `{}`)
	runContribSync(t, f, "^11")
	assertContribCalls(t, f)
	site, err := readContribComposer(f.appRoot)
	if err != nil || site.Require["acme/root"] != "^1" {
		t.Fatalf("inherited requirement changed: %+v (%v)", site, err)
	}
}

func TestDrupalContribSyncConvergesUnderSharedLock(t *testing.T) {
	f, _ := completedContrib(t, `{}`)
	lock, err := acquireScaffoldLock(f.appRoot)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.release()
	if code := f.run(t, contribSyncCommand, "module", "example", "^10"); code != 1 ||
		!strings.Contains(f.stderr.String(), "Another Lando scaffold is already running") {
		t.Fatalf("sync exited %d: %s", code, f.stderr.String())
	}
	assertContribCalls(t, f)
}

func TestDrupalContribSyncTreatsUnusableRecordAsEmpty(t *testing.T) {
	for _, tc := range []struct{ name, content string }{{"missing", ""}, {"corrupt", "{"}, {"unsupported", `{"version":2,"require":{},"requireDev":{}}`}} {
		t.Run(tc.name, func(t *testing.T) {
			f, _ := completedContrib(t, `{}`)
			path := filepath.Join(f.appRoot, ".lando-drupal-contrib-sync.json")
			if tc.content == "" {
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
			} else {
				writeContribTestFile(t, path, tc.content)
			}
			runContribSync(t, f, "^11")
			assertContribCalls(t, f, []string{"--working-dir=" + f.appRoot, "update", "--with-all-dependencies", "--no-interaction",
				"drupal/coder", "drupal/core-composer-scaffold", "drupal/core-dev", "drupal/core-project-message", "drupal/core-recommended", "drush/drush"})
			if record := loadContribSyncRecord(f.appRoot); record.Version != 1 || record.Require["drupal/core-recommended"] != "^11" {
				t.Fatalf("record was not recovered: %+v", record)
			}
		})
	}
}

func TestDesiredContribRequirements(t *testing.T) {
	for _, tc := range []struct {
		name            string
		site, extension contribComposerManifest
		prod, dev       map[string]string
	}{
		{"defaults", contribComposerManifest{}, contribComposerManifest{},
			map[string]string{"drupal/core-recommended": "^11", "drush/drush": "*"},
			map[string]string{"drupal/core-dev": "^11", "drupal/coder": "*"}},
		{"optional core, skip rules, explicit tools and buckets", contribComposerManifest{Require: map[string]string{"drupal/core-project-message": "^10"}}, contribComposerManifest{
			Name: "drupal/example", Require: map[string]string{"php": "^8.4", "ext-json": "*", "drupal/core": "^10", "drupal/example": "*", "drupal/coder": "^8", "acme/a": "^1"},
			RequireDev: map[string]string{"drush/drush": "^13", "drupal/core-composer-scaffold": "^10", "acme/a": "^2", "acme/b": "^3"}},
			map[string]string{"drupal/core-recommended": "^11", "drupal/core-project-message": "^11", "drupal/coder": "^8", "acme/a": "^1"},
			map[string]string{"drupal/core-dev": "^11", "drush/drush": "^13", "acme/b": "^3"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := desiredContribRequirements("^11", tc.site, tc.extension)
			if err != nil || !maps.Equal(got.Require, tc.prod) || !maps.Equal(got.RequireDev, tc.dev) {
				t.Fatalf("desired = %+v, err = %v, want %v / %v", got, err, tc.prod, tc.dev)
			}
		})
	}
}
