package main

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestFakeComposerProcess(t *testing.T) {
	if os.Getenv("LANDO_TEST_FAKE") != "composer" {
		return
	}
	os.Exit(runFakeComposer(argsAfterSeparator(os.Args)))
}

func TestScaffoldKillProcess(t *testing.T) {
	if os.Getenv("LANDO_TEST_KILL") != "1" {
		return
	}
	point := os.Getenv("LANDO_TEST_KILL_AT")
	crash := func(step string) {
		if step == point {
			os.Exit(137)
		}
	}
	env := envMap(os.Environ())
	streams := helperIO{os.Stdin, os.Stdout, os.Stderr, env}
	args := argsAfterSeparator(os.Args)
	var code int
	switch os.Getenv("LANDO_TEST_KILL_COMMAND") {
	case "drupal-scaffold":
		code = runDrupalScaffold(args, streams, crash)
	case "drupal-cms-scaffold":
		code = runDrupalCmsScaffold(args, streams, crash)
	default:
		code = runCreateProject(args, streams, crash)
	}
	os.Exit(code)
}

func argsAfterSeparator(argv []string) []string {
	for index, argument := range argv {
		if argument == "--" {
			return argv[index+1:]
		}
	}
	return nil
}

func envMap(entries []string) map[string]string {
	env := make(map[string]string, len(entries))
	for _, entry := range entries {
		name, value, ok := strings.Cut(entry, "=")
		if ok {
			env[name] = value
		}
	}
	return env
}

type scaffoldFixture struct {
	root     string
	appRoot  string
	binDir   string
	logPath  string
	env      map[string]string
	stdout   bytes.Buffer
	stderr   bytes.Buffer
	streams  helperIO
	failures []string
}

func newScaffoldFixture(t *testing.T, overrides map[string]string) *scaffoldFixture {
	t.Helper()
	root := t.TempDir()
	appRoot := filepath.Join(root, "app")
	binDir := filepath.Join(root, "bin")
	if err := os.MkdirAll(appRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeFakeExecutable(t, filepath.Join(binDir, "composer"), `#!/bin/sh
exec "$LANDO_TEST_FAKE_BINARY" -test.run=^TestFakeComposerProcess$ -- "$@"
`)
	writeFakeExecutable(t, filepath.Join(binDir, "git"), `#!/bin/sh
case "$3" in
  rev-parse)
    if test "${LANDO_TEST_COMPOSER_MODE:-}" = installed-ref; then
      printf '%s\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    else
      printf '%s\n' c788b1e2f2be29f62c9812b2b0558472afa61d6d
    fi;;
  status)
    if test "${LANDO_TEST_COMPOSER_MODE:-}" = installed-dirty; then printf ' M svg_image.module\n'; fi;;
  *) exit 2;;
esac
`)
	env := envMap(os.Environ())
	env["PATH"] = binDir + string(os.PathListSeparator) + env["PATH"]
	env["LANDO_TEST_FAKE"] = "composer"
	env["LANDO_TEST_FAKE_BINARY"] = os.Args[0]
	env["LANDO_TEST_COMPOSER_LOG"] = filepath.Join(root, "composer.log")
	env["LANDO_TEST_COMPOSER_RECIPE"] = "create"
	env["LANDO_TEST_COMPOSER_HOOKS"] = "none"
	env["LANDO_TEST_COMPOSER_RELEASE"] = "first"
	env["LANDO_TEST_COMPOSER_MODE"] = "secure"
	env["LANDO_CREATE_PROJECT_APP_ROOT"] = appRoot
	env["LANDO_DRUPAL_APP_ROOT"] = appRoot
	env["LANDO_DRUPAL_CMS_APP_ROOT"] = appRoot
	for name, value := range overrides {
		env[name] = value
	}
	fixture := &scaffoldFixture{
		root:    root,
		appRoot: appRoot,
		binDir:  binDir,
		logPath: env["LANDO_TEST_COMPOSER_LOG"],
		env:     env,
	}
	fixture.streams = helperIO{
		stdin:  strings.NewReader(""),
		stdout: &fixture.stdout,
		stderr: &fixture.stderr,
		env:    fixture.env,
	}
	return fixture
}

func writeFakeExecutable(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
}

func (f *scaffoldFixture) reset() {
	f.stdout.Reset()
	f.stderr.Reset()
}

func (f *scaffoldFixture) run(t *testing.T, command string, args ...string) int {
	t.Helper()
	f.reset()
	switch command {
	case "drupal-scaffold":
		return runDrupalScaffold(args, f.streams, nil)
	case "drupal-cms-scaffold":
		return runDrupalCmsScaffold(args, f.streams, nil)
	default:
		return runCreateProject(args, f.streams, nil)
	}
}

func (f *scaffoldFixture) kill(t *testing.T, command string, point string, args ...string) {
	t.Helper()
	childEnv := map[string]string{}
	for name, value := range f.env {
		childEnv[name] = value
	}
	childEnv["LANDO_TEST_KILL"] = "1"
	childEnv["LANDO_TEST_KILL_AT"] = point
	childEnv["LANDO_TEST_KILL_COMMAND"] = command
	child := exec.Command(os.Args[0], "-test.run=^TestScaffoldKillProcess$", "--")
	child.Args = append(child.Args, args...)
	child.Dir = f.appRoot
	child.Env = environSlice(childEnv)
	output, err := child.CombinedOutput()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 137 {
		t.Fatalf("kill at %s exited with %v, want 137\n%s", point, err, output)
	}
}

func (f *scaffoldFixture) calls(t *testing.T) []string {
	t.Helper()
	data, err := os.ReadFile(f.logPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	text := strings.TrimSpace(string(data))
	if text == "" {
		return nil
	}
	return strings.Split(text, "\n")
}

func (f *scaffoldFixture) assertNoScaffoldState(t *testing.T) {
	t.Helper()
	entries, err := os.ReadDir(f.appRoot)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".lando-scaffold") ||
			strings.HasPrefix(entry.Name(), ".lando-create-project") ||
			strings.HasPrefix(entry.Name(), ".lando-drupal") {
			t.Fatalf("leftover scaffold state in app root: %s", entry.Name())
		}
	}
}

func mustEqualStrings(t *testing.T, actual []string, expected []string) {
	t.Helper()
	if len(actual) != len(expected) {
		t.Fatalf("calls = %v, want %v", actual, expected)
	}
	for index := range expected {
		if actual[index] != expected[index] {
			t.Fatalf("calls = %v, want %v", actual, expected)
		}
	}
}

func assertFileText(t *testing.T, path string, expected string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if string(data) != expected {
		t.Fatalf("%s = %q, want %q", path, string(data), expected)
	}
}

func assertDirectoryNames(t *testing.T, path string, expected []string) {
	t.Helper()
	entries, err := os.ReadDir(path)
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	if len(expected) == 0 {
		if len(names) != 0 {
			t.Fatalf("%s contains %v, want nothing", path, names)
		}
		return
	}
	mustEqualStrings(t, names, expected)
}
