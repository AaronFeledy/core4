package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"os"
	"testing"
)

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
