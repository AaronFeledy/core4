package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestExecRunSignalsSetsidGrandchildBeforeItsParentExits(t *testing.T) {
	setsid, err := exec.LookPath("setsid")
	if err != nil {
		t.Skip("setsid unavailable")
	}
	root := t.TempDir()
	ready, received := filepath.Join(root, "ready"), filepath.Join(root, "received")
	f := execRunStart(t, "/bin/sh", "-c", setsid+" /bin/sh -c 'trap \"echo TERM > "+received+"; exit 0\" TERM; echo ready > "+ready+"; while :; do sleep 0.01; done' & trap '' TERM; wait")
	execTestWaitFile(t, ready)
	execRunWrite(t, f, execEncodeFrame(execFrameSignal, []byte{execSignalTerminate}))
	if state := execRunWait(t, f, 2*time.Second); state.ExitCode() != 143 {
		t.Fatalf("exit=%d stderr=%q", state.ExitCode(), f.stderr.String())
	}
	if bytes, err := os.ReadFile(received); err != nil || string(bytes) != "TERM\n" {
		t.Fatalf("grandchild did not exit gracefully: %q, %v", bytes, err)
	}
}
