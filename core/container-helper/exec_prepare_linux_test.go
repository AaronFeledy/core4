package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"syscall"
	"testing"
)

func TestExecPrepareProvisionsPrivateDirectoryForNonRootUser(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("root control exec required")
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		t.Fatal(err)
	}
	nonce := hex.EncodeToString(random[:])
	dir := "/tmp/lando-exec-session-" + nonce
	t.Cleanup(func() { os.RemoveAll(dir) })
	var out bytes.Buffer
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(binary)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(data)
	if code := runExecPrepare([]string{dir, nonce, "1000:1000", hex.EncodeToString(digest[:])}, helperIO{stdout: &out}); code != 0 {
		t.Fatalf("prepare: %s", out.String())
	}
	info, err := os.Lstat(dir)
	if err != nil {
		t.Fatal(err)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != 1000 || info.Mode().Perm() != 0700 {
		t.Fatalf("session ownership/mode: %+v %v", stat, info.Mode())
	}
	if !execExists(dir, "initialized") {
		t.Fatal("session was not initialized")
	}
	for _, name := range []string{"lock", "initialized"} {
		info, err := os.Lstat(dir + "/" + name)
		if err != nil {
			t.Fatal(err)
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || stat.Uid != 1000 || info.Mode().Perm() != 0600 {
			t.Fatalf("session member ownership/mode: %s %+v %v", name, stat, info.Mode())
		}
	}
}

func TestExecCancelWithoutSupervisorCanCollectAndCleanUp(t *testing.T) {
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		t.Fatal(err)
	}
	nonce := hex.EncodeToString(random[:])
	dir := "/tmp/lando-exec-session-" + nonce
	t.Cleanup(func() { os.RemoveAll(dir) })
	if err := execPrivateDirectory(dir); err != nil {
		t.Fatal(err)
	}
	if err := execMark(dir, "initialized"); err != nil {
		t.Fatal(err)
	}
	f := &supervisorFixture{dir: dir, nonce: nonce}
	for _, op := range []string{"cancel", "status", "collect"} {
		if r := execTestControl(t, f, op); !r.OK || !r.Joined || r.State != "cancelled" || r.ExitCode != nil {
			t.Fatalf("%s: %+v", op, r)
		}
	}
	var out bytes.Buffer
	if code := runExecCleanup([]string{dir, nonce}, helperIO{stdout: &out}); code != 0 {
		t.Fatalf("cleanup: %s", out.String())
	}
	if code := runExecSupervisor([]string{dir, nonce, "--", "/bin/true"}, helperIO{}); code != 125 {
		t.Fatalf("late supervisor accepted removed session: %d", code)
	}
}

func TestExecPrepareFailureProcess(t *testing.T) {
	if os.Getenv("LANDO_TEST_EXEC_PREPARE_FAILURE") != "1" {
		return
	}
	if err := syscall.Setuid(1000); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir() + "/session"
	if err := prepareExecDirectory(dir, 1001); err == nil {
		t.Fatal("unprivileged ownership change unexpectedly accepted")
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("partial session remains after failed preparation: %v", err)
	}
}

func TestExecPrepareRollsBackWhenOwnershipCannotBeAssigned(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("root control exec required")
	}
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(binary, "-test.run=^TestExecPrepareFailureProcess$")
	cmd.Env = append(os.Environ(), "LANDO_TEST_EXEC_PREPARE_FAILURE=1")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("prepare failure process: %v\n%s", err, output)
	}
}
