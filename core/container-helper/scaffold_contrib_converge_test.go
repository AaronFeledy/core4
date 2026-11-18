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

func contribMarker(f *scaffoldFixture) string {
	return filepath.Join(f.appRoot, ".lando-drupal-contrib-sync-complete")
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
			record := contribMarker(f)
			before, err := os.ReadFile(record)
			if err != nil {
				t.Fatal(err)
			}
			wd := "--working-dir=" + f.appRoot
			prod := []string{wd, "require", "--no-update", "--no-interaction", "drupal/core-composer-scaffold:^10", "drupal/core-project-message:^10", "drupal/core-recommended:^10"}
			dev := []string{wd, "require", "--dev", "--no-update", "--no-interaction", "drupal/core-dev:^10"}
			update := []string{wd, "update", "--with-all-dependencies", "--no-interaction"}
			if mode == "fail-update" {
				f.env["LANDO_TEST_COMPOSER_MODE"] = mode
				code := f.run(t, contribSyncCommand, "module", "example", "^10")
				if code != 1 || !strings.Contains(f.stderr.String(), "lando drupal-contrib-sync") {
					t.Fatalf("sync exited %d: %s", code, f.stderr.String())
				}
				assertContribCalls(t, f, prod, dev, update)
				assertFileText(t, record, string(before))
				assertContribSiteMode(t, dir)
				clearContribCalls(t, f)
				delete(f.env, "LANDO_TEST_COMPOSER_MODE")
				// The failed run restored composer.json, so the retry makes the same edits again.
				runContribSync(t, f, "^10")
				assertContribCalls(t, f, prod, dev, update)
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

func TestDrupalContribSyncLeavesSiteOwnedDependencies(t *testing.T) {
	// acme/root comes from the recommended project, so the site owns it.
	f, extension := completedContrib(t, `{"require":{"acme/root":"^9"}}`)
	for _, declared := range []string{`{"require":{"acme/root":"^10"}}`, `{}`} {
		writeContribTestFile(t, extension, declared)
		runContribSync(t, f, "^11")
		assertContribCalls(t, f)
	}
	site, err := readContribComposer(f.appRoot)
	if err != nil || site.Require["acme/root"] != "^1" {
		t.Fatalf("site-owned requirement changed: %+v (%v)", site, err)
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
	for _, tc := range []struct{ name, content string }{{"empty", ""}, {"corrupt", "{"}, {"unsupported", `{"version":2,"require":{},"requireDev":{}}`}} {
		t.Run(tc.name, func(t *testing.T) {
			f, _ := completedContrib(t, `{}`)
			writeContribTestFile(t, contribMarker(f), tc.content)
			runContribSync(t, f, "^11")
			// Nothing proves which core the site has, so it resolves the whole site again.
			assertContribCalls(t, f, []string{"--working-dir=" + f.appRoot, "update", "--with-all-dependencies", "--no-interaction"})
			if record := loadContribSyncRecord(contribMarker(f)); record.Version != 1 || record.Require["drupal/core-recommended"] != "^11" {
				t.Fatalf("record was not recovered: %+v", record)
			}
		})
	}
}

func TestDesiredContribRequirements(t *testing.T) {
	for _, tc := range []struct {
		name            string
		site, extension contribComposerManifest
		previous        contribSyncRecord
		prod, dev       map[string]string
	}{
		{"defaults", contribComposerManifest{}, contribComposerManifest{}, contribSyncRecord{},
			map[string]string{"drupal/core-recommended": "^11", "drush/drush": "*"},
			map[string]string{"drupal/core-dev": "^11", "drupal/coder": "*"}},
		{"optional core, skip rules, explicit tools and buckets", contribComposerManifest{Require: map[string]string{"drupal/core-project-message": "^10"}}, contribComposerManifest{
			Name: "drupal/example", Require: map[string]string{"php": "^8.4", "ext-json": "*", "drupal/core": "^10", "drupal/example": "*", "drupal/coder": "^8", "acme/a": "^1"},
			RequireDev: map[string]string{"drush/drush": "^13", "drupal/core-composer-scaffold": "^10", "acme/a": "^2", "acme/b": "^3"}},
			contribSyncRecord{},
			map[string]string{"drupal/core-recommended": "^11", "drupal/core-project-message": "^11", "drupal/coder": "^8", "acme/a": "^1"},
			map[string]string{"drupal/core-dev": "^11", "drush/drush": "^13", "acme/b": "^3"}},
		{"site-owned package stays with the site until a sync manages it",
			contribComposerManifest{Require: map[string]string{"acme/site": "^1", "acme/managed": "^1"}},
			contribComposerManifest{Require: map[string]string{"acme/site": "^2", "acme/managed": "^2"}},
			contribSyncRecord{Version: 1, Require: map[string]string{"acme/managed": "^1"}, RequireDev: map[string]string{}},
			map[string]string{"drupal/core-recommended": "^11", "drush/drush": "*", "acme/managed": "^2"},
			map[string]string{"drupal/core-dev": "^11", "drupal/coder": "*"}},
		{"without a valid record the extension's requirements win",
			contribComposerManifest{Require: map[string]string{"acme/site": "^1"}},
			contribComposerManifest{Require: map[string]string{"acme/site": "^2"}},
			contribSyncRecord{},
			map[string]string{"drupal/core-recommended": "^11", "drush/drush": "*", "acme/site": "^2"},
			map[string]string{"drupal/core-dev": "^11", "drupal/coder": "*"}},
		{"site-owned Drush and Coder keep their constraints",
			contribComposerManifest{Require: map[string]string{"drush/drush": "^12"}, RequireDev: map[string]string{"drupal/coder": "^8"}},
			contribComposerManifest{},
			contribSyncRecord{Version: 1, Require: map[string]string{}, RequireDev: map[string]string{}},
			map[string]string{"drupal/core-recommended": "^11"},
			map[string]string{"drupal/core-dev": "^11"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := desiredContribRequirements("^11", tc.site, tc.extension, tc.previous)
			if err != nil || !maps.Equal(got.Require, tc.prod) || !maps.Equal(got.RequireDev, tc.dev) {
				t.Fatalf("desired = %+v, err = %v, want %v / %v", got, err, tc.prod, tc.dev)
			}
		})
	}
}

func TestDrupalContribSyncRestoresComposerFilesWhenItFails(t *testing.T) {
	f, extension := completedContrib(t, `{}`)
	files := []string{filepath.Join(f.appRoot, "composer.json"), filepath.Join(f.appRoot, "composer.lock")}
	writeContribTestFile(t, files[1], `{"content-hash":"before"}`)
	before := make([]string, len(files))
	for i, file := range files {
		data, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		before[i] = string(data)
	}
	// The extension asks for a package Composer can't resolve.
	writeContribTestFile(t, extension, `{"require":{"acme/missing":"^1"}}`)
	f.env["LANDO_TEST_COMPOSER_MODE"] = "fail-update"
	if code := f.run(t, contribSyncCommand, "module", "example", "^11"); code != 1 {
		t.Fatalf("failing sync exited %d: %s", code, f.stderr.String())
	}
	for i, file := range files {
		assertFileText(t, file, before[i])
	}
	// Once the extension drops it, nothing of the failed attempt is left to resolve.
	delete(f.env, "LANDO_TEST_COMPOSER_MODE")
	writeContribTestFile(t, extension, `{}`)
	clearContribCalls(t, f)
	if code := f.run(t, contribSyncCommand, "module", "example", "^11"); code != 0 ||
		!strings.Contains(f.stdout.String(), "is up to date") {
		t.Fatalf("sync after the failure exited %d: %s", code, f.stderr.String())
	}
	assertContribCalls(t, f)
}

func TestDrupalContribSyncRestoresAHandEditedManagedPackage(t *testing.T) {
	f, _ := completedContrib(t, `{}`)
	site := filepath.Join(f.appRoot, "composer.json")
	manifest := readFakeJSON(site)
	manifest["require"].(map[string]any)["drush/drush"] = "^12"
	writeFakeJSON(site, manifest)
	runContribSync(t, f, "^11")
	wd := "--working-dir=" + f.appRoot
	assertContribCalls(t, f,
		[]string{wd, "require", "--no-update", "--no-interaction", "drush/drush:*"},
		[]string{wd, "update", "--with-all-dependencies", "--no-interaction", "drush/drush"})
}

func TestDrupalContribSyncConvergesASiteWithoutMarker(t *testing.T) {
	f, _ := completedContrib(t, `{}`)
	if err := os.Remove(contribMarker(f)); err != nil {
		t.Fatal(err)
	}
	runContribSync(t, f, "^11")
	// Nothing records what was applied, so the site resolves again instead of restaging.
	assertContribCalls(t, f, []string{"--working-dir=" + f.appRoot, "update", "--with-all-dependencies", "--no-interaction"})
	if record := loadContribSyncRecord(contribMarker(f)); record.Version != 1 {
		t.Fatalf("sync did not record its requirements: %+v", record)
	}
}

func TestDrupalContribSyncConvergesAfterResumingWithNewInputs(t *testing.T) {
	f := newContribFixture(t)
	mount := contribTestMount(t, f, "module", "example", "type: module\n")
	extension := filepath.Join(mount, "composer.json")
	writeContribTestFile(t, extension, `{}`)
	args := []string{"module", "example", "^11"}
	f.kill(t, contribSyncCommand, "hook-composer-install", args...)
	writeContribTestFile(t, extension, `{"require":{"acme/new":"^1"}}`)
	clearContribCalls(t, f)
	runContribSync(t, f, "^11")
	wd := "--working-dir=" + f.appRoot
	assertContribCalls(t, f,
		[]string{wd, "require", "--no-update", "--no-interaction", "acme/new:^1"},
		[]string{wd, "update", "--with-all-dependencies", "--no-interaction", "acme/new"})
	if record := loadContribSyncRecord(contribMarker(f)); record.Require["acme/new"] != "^1" {
		t.Fatalf("resumed sync did not record the new requirement: %+v", record)
	}
}
