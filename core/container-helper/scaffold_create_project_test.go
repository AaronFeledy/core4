package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCreateProjectRunsComposerHooksAroundInstall(t *testing.T) {
	fixture := newScaffoldFixture(t, map[string]string{"LANDO_TEST_COMPOSER_HOOKS": "both"})

	if code := fixture.run(t, "create-project", "laravel/laravel"); code != 0 {
		t.Fatalf("create-project exited %d: %s", code, fixture.stderr.String())
	}

	calls := fixture.calls(t)
	mustEqualStrings(t, calls, []string{
		"create-project",
		"run-script post-root-package-install",
		"install",
		"run-script post-create-project-cmd",
	})
	for _, path := range []string{"composer.json", "app/index.php", "public/index.php", "vendor/autoload.php"} {
		if !pathExists(filepath.Join(fixture.appRoot, filepath.FromSlash(path))) {
			t.Fatalf("missing promoted path %s", path)
		}
	}
	fixture.assertNoScaffoldState(t)
}

func TestCreateProjectResumeSkipsSuccessfulRootHook(t *testing.T) {
	fixture := newScaffoldFixture(t, map[string]string{
		"LANDO_TEST_COMPOSER_HOOKS":        "both",
		"LANDO_TEST_COMPOSER_FAIL_INSTALL": "1",
	})
	if code := fixture.run(t, "create-project", "acme/resumable"); code == 0 {
		t.Fatal("install failure was not reported")
	}
	if !strings.Contains(fixture.stderr.String(), "could not install dependencies") {
		t.Fatalf("missing install remediation: %s", fixture.stderr.String())
	}
	delete(fixture.env, "LANDO_TEST_COMPOSER_FAIL_INSTALL")

	if code := fixture.run(t, "create-project", "acme/resumable"); code != 0 {
		t.Fatalf("resume exited %d: %s", code, fixture.stderr.String())
	}

	calls := fixture.calls(t)
	mustEqualStrings(t, calls, []string{
		"create-project",
		"run-script post-root-package-install",
		"install",
		"install",
		"run-script post-create-project-cmd",
	})
	fixture.assertNoScaffoldState(t)
}

func TestCreateProjectEmptyHooksAreUndefined(t *testing.T) {
	for _, hooks := range []string{"none", "empty"} {
		t.Run(hooks, func(t *testing.T) {
			fixture := newScaffoldFixture(t, map[string]string{"LANDO_TEST_COMPOSER_HOOKS": hooks})

			if code := fixture.run(t, "create-project", "acme/hookless"); code != 0 {
				t.Fatalf("create-project exited %d: %s", code, fixture.stderr.String())
			}
			for _, call := range fixture.calls(t) {
				if strings.HasPrefix(call, "run-script") {
					t.Fatalf("ran an undefined hook: %s", call)
				}
			}
		})
	}
}

func TestCreateProjectDefinedHookFailureFailsAndCanResume(t *testing.T) {
	for _, testCase := range []struct {
		name  string
		hooks string
		hook  string
	}{
		{name: "root", hooks: "failing-root", hook: "post-root-package-install"},
		{name: "create", hooks: "failing-create", hook: "post-create-project-cmd"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			fixture := newScaffoldFixture(t, map[string]string{"LANDO_TEST_COMPOSER_HOOKS": testCase.hooks})

			if code := fixture.run(t, "create-project", "acme/hooked"); code == 0 {
				t.Fatal("a failing hook did not fail the command")
			}
			if !strings.Contains(fixture.stderr.String(), testCase.hook) {
				t.Fatalf("missing hook name in error: %s", fixture.stderr.String())
			}
			if !pathExists(filepath.Join(fixture.appRoot, ".lando-create-project-manifest")) {
				t.Fatal("failure did not keep the recovery manifest")
			}
			fixture.env["LANDO_TEST_COMPOSER_HOOKS"] = "both"
			if code := fixture.run(t, "create-project", "acme/hooked"); code != 0 {
				t.Fatalf("resume exited %d: %s", code, fixture.stderr.String())
			}
			fixture.assertNoScaffoldState(t)
		})
	}
}

func TestCreateProjectNoScriptsSkipsHooksAndInstallScripts(t *testing.T) {
	fixture := newScaffoldFixture(t, map[string]string{"LANDO_TEST_COMPOSER_HOOKS": "both"})

	if code := fixture.run(t, "create-project", "--no-scripts", "acme/skipped"); code != 0 {
		t.Fatalf("create-project exited %d: %s", code, fixture.stderr.String())
	}
	mustEqualStrings(t, fixture.calls(t), []string{"create-project", "install"})
}

func TestCreateProjectAppRootPrecedence(t *testing.T) {
	fixture := newScaffoldFixture(t, nil)
	delete(fixture.env, "LANDO_CREATE_PROJECT_APP_ROOT")
	mounted := filepath.Join(fixture.root, "workspace")
	if err := os.MkdirAll(mounted, 0o755); err != nil {
		t.Fatal(err)
	}
	fixture.env["LANDO_PROJECT_MOUNT"] = mounted

	if code := fixture.run(t, "create-project", "acme/mounted-root"); code != 0 {
		t.Fatalf("create-project exited %d: %s", code, fixture.stderr.String())
	}
	if !pathExists(filepath.Join(mounted, "composer.json")) {
		t.Fatal("create-project did not use LANDO_PROJECT_MOUNT")
	}
	if pathExists(filepath.Join(fixture.appRoot, "composer.json")) {
		t.Fatal("create-project wrote to the fallback app root")
	}

	fixture.env["LANDO_CREATE_PROJECT_APP_ROOT"] = fixture.appRoot
	if code := fixture.run(t, "create-project", "acme/explicit-root"); code != 0 {
		t.Fatalf("create-project exited %d: %s", code, fixture.stderr.String())
	}
	if !pathExists(filepath.Join(fixture.appRoot, "composer.json")) {
		t.Fatal("explicit app root did not win")
	}
}

func TestCreateProjectRefusesExistingComposerJSON(t *testing.T) {
	fixture := newScaffoldFixture(t, nil)
	if err := os.WriteFile(filepath.Join(fixture.appRoot, "composer.json"), []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if code := fixture.run(t, "create-project", "laravel/laravel"); code == 0 {
		t.Fatal("create-project accepted an occupied app root")
	}
	if !strings.Contains(fixture.stderr.String(), "lando composer install") {
		t.Fatalf("missing remediation: %s", fixture.stderr.String())
	}
	if len(fixture.calls(t)) != 0 {
		t.Fatal("create-project invoked Composer before refusing")
	}
	data, err := os.ReadFile(filepath.Join(fixture.appRoot, "composer.json"))
	if err != nil || string(data) != "{}\n" {
		t.Fatal("create-project changed the existing composer.json")
	}
}

func TestCreateProjectRefusesCompletedProjectOnRerun(t *testing.T) {
	fixture := newScaffoldFixture(t, nil)
	if code := fixture.run(t, "create-project", "laravel/laravel"); code != 0 {
		t.Fatalf("create-project exited %d: %s", code, fixture.stderr.String())
	}
	if code := fixture.run(t, "create-project", "laravel/laravel"); code == 0 {
		t.Fatal("rerun created a second project")
	}
	if !strings.Contains(fixture.stderr.String(), "composer.json already exists") {
		t.Fatalf("unexpected rerun error: %s", fixture.stderr.String())
	}
}

func TestCreateProjectRejectsInvalidArguments(t *testing.T) {
	for _, testCase := range []struct {
		args    []string
		message string
	}{
		{args: nil, message: "needs a Composer package"},
		{args: []string{"laravel laravel"}, message: "vendor/package syntax"},
		{args: []string{"-bad/pkg"}, message: "cannot start with a dash"},
		{args: []string{"acme/pkg", "-bad"}, message: "versions cannot start with a dash"},
		{args: []string{"acme/pkg", "^1", "extra"}, message: "one package and an optional version"},
	} {
		fixture := newScaffoldFixture(t, nil)
		if code := fixture.run(t, "create-project", testCase.args...); code == 0 {
			t.Fatalf("%v was accepted", testCase.args)
		}
		if !strings.Contains(fixture.stderr.String(), testCase.message) {
			t.Fatalf("%v produced %q, want %q", testCase.args, fixture.stderr.String(), testCase.message)
		}
		if len(fixture.calls(t)) != 0 {
			t.Fatalf("%v reached Composer", testCase.args)
		}
	}
}
