package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCreateProjectLockAdmission(t *testing.T) {
	t.Run("live owner blocks", func(t *testing.T) {
		fixture := newScaffoldFixture(t, nil)
		lock, err := acquireScaffoldLock(fixture.appRoot)
		if err != nil {
			t.Fatal(err)
		}
		defer lock.release()

		if code := fixture.run(t, "create-project", "acme/blocked"); code == 0 {
			t.Fatal("a live scaffold lock did not block")
		}
		if !strings.Contains(fixture.stderr.String(), "Another Lando scaffold is already running") {
			t.Fatalf("unexpected lock error: %s", fixture.stderr.String())
		}
	})
	t.Run("unlocked file ignores stale diagnostics", func(t *testing.T) {
		fixture := newScaffoldFixture(t, nil)
		path := filepath.Join(fixture.appRoot, scaffoldLockName)
		if err := os.WriteFile(path, []byte(fmt.Sprintf("pid=%d host=old\n", os.Getpid())), 0o600); err != nil {
			t.Fatal(err)
		}

		if code := fixture.run(t, "create-project", "acme/recovered"); code != 0 {
			t.Fatalf("create-project exited %d: %s", code, fixture.stderr.String())
		}
		fixture.assertNoScaffoldState(t)
	})
	t.Run("empty unlocked file is reused", func(t *testing.T) {
		fixture := newScaffoldFixture(t, nil)
		if err := os.WriteFile(filepath.Join(fixture.appRoot, scaffoldLockName), nil, 0o600); err != nil {
			t.Fatal(err)
		}

		if code := fixture.run(t, "create-project", "acme/owned"); code != 0 {
			t.Fatalf("create-project exited %d: %s", code, fixture.stderr.String())
		}
		fixture.assertNoScaffoldState(t)
	})
}

func TestCreateProjectNeverOverwritesAndFillsEmptyDirectories(t *testing.T) {
	fixture := newScaffoldFixture(t, nil)
	if err := os.WriteFile(filepath.Join(fixture.appRoot, ".lando.yml"), []byte("name: fixture\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fixture.appRoot, "README.md"), []byte("user-owned\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(fixture.appRoot, "public"), 0o755); err != nil {
		t.Fatal(err)
	}

	if code := fixture.run(t, "create-project", "acme/mounted"); code != 0 {
		t.Fatalf("create-project exited %d: %s", code, fixture.stderr.String())
	}
	assertFileText(t, filepath.Join(fixture.appRoot, ".lando.yml"), "name: fixture\n")
	assertFileText(t, filepath.Join(fixture.appRoot, "README.md"), "user-owned\n")
	assertFileText(t, filepath.Join(fixture.appRoot, "public", "index.php"), "first\n")
	assertFileText(t, filepath.Join(fixture.appRoot, "app", "index.php"), "first\n")
}

func TestCreateProjectAcceptsHostileTopLevelNames(t *testing.T) {
	fixture := newScaffoldFixture(t, map[string]string{
		"LANDO_TEST_COMPOSER_EXTRA": "README example.txt\na:b.txt\ncafé.txt",
	})
	if code := fixture.run(t, "create-project", "acme/names"); code != 0 {
		t.Fatalf("create-project exited %d: %s", code, fixture.stderr.String())
	}
	for _, name := range []string{"README example.txt", "a:b.txt", "café.txt"} {
		if !pathExists(filepath.Join(fixture.appRoot, name)) {
			t.Fatalf("missing promoted top-level name %q", name)
		}
	}
}

func TestCreateProjectRejectsNewlineName(t *testing.T) {
	fixture := newScaffoldFixture(t, map[string]string{
		"LANDO_TEST_COMPOSER_NEWLINE": "1",
	})
	if code := fixture.run(t, "create-project", "acme/newline"); code == 0 {
		t.Fatal("create-project accepted a newline in a top-level name")
	}
	if !strings.Contains(fixture.stderr.String(), "Invalid create-project scaffold entry") {
		t.Fatalf("unexpected error: %s", fixture.stderr.String())
	}
	assertDirectoryNames(t, fixture.appRoot, nil)
}

func TestCreateProjectResumesTheSameStagedGeneration(t *testing.T) {
	fixture := newScaffoldFixture(t, nil)
	fixture.kill(t, "create-project", "sibling-promoted", "acme/pinned")

	fixture.env["LANDO_TEST_COMPOSER_RELEASE"] = "second"
	if code := fixture.run(t, "create-project", "acme/pinned"); code != 0 {
		t.Fatalf("resume exited %d: %s", code, fixture.stderr.String())
	}
	createProjects := 0
	for _, call := range fixture.calls(t) {
		if call == "create-project" {
			createProjects++
		}
	}
	if createProjects != 1 {
		t.Fatalf("resume restaged the project %d times", createProjects)
	}
	assertFileText(t, filepath.Join(fixture.appRoot, "app", "index.php"), "first\n")
	assertFileText(t, filepath.Join(fixture.appRoot, "public", "index.php"), "first\n")
	fixture.assertNoScaffoldState(t)
}

func TestCreateProjectResumesAfterKillAtEveryStep(t *testing.T) {
	points := recordCreateProjectPoints(t)
	for _, point := range points {
		t.Run(point, func(t *testing.T) {
			fixture := newScaffoldFixture(t, nil)
			fixture.kill(t, "create-project", point, "acme/crash")

			code := fixture.run(t, "create-project", "acme/crash")
			if point == "manifest-removed" {
				// The project was already published when the kill landed; the
				// only correct rerun is the occupied-app-root refusal.
				if code == 0 {
					t.Fatal("a completed project was created twice")
				}
				if !strings.Contains(fixture.stderr.String(), "composer.json already exists") {
					t.Fatalf("unexpected rerun error: %s", fixture.stderr.String())
				}
			} else if code != 0 {
				t.Fatalf("resume exited %d: %s", code, fixture.stderr.String())
			}
			assertFileText(t, filepath.Join(fixture.appRoot, "app", "index.php"), "first\n")
			assertFileText(t, filepath.Join(fixture.appRoot, "public", "index.php"), "first\n")
			fixture.assertNoScaffoldState(t)
		})
	}
}

func recordCreateProjectPoints(t *testing.T) []string {
	t.Helper()
	fixture := newScaffoldFixture(t, nil)
	seen := make([]string, 0)
	unique := make([]string, 0)
	crash := func(point string) {
		seen = append(seen, point)
		for _, existing := range unique {
			if existing == point {
				return
			}
		}
		unique = append(unique, point)
	}
	if code := runCreateProject([]string{"acme/points"}, fixture.streams, crash); code != 0 {
		t.Fatalf("recording run exited %d: %s", code, fixture.stderr.String())
	}
	if len(seen) == 0 {
		t.Fatal("the engine recorded no steps")
	}
	return unique
}
