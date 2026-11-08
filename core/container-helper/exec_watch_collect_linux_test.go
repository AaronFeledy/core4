package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestExecWatchCollectsSupervisorWithActualExitCode(t *testing.T) {
	permission := filepath.Join(t.TempDir(), "not-executable")
	if err := os.WriteFile(permission, []byte("#!/bin/sh\nexit 0\n"), 0644); err != nil {
		t.Fatal(err)
	}
	for _, command := range []struct {
		name string
		argv []string
		code int
	}{
		{"exit", []string{"/bin/sh", "-c", "exit 23"}, 23},
		{"missing", []string{"/lando-missing-watch-command"}, 127},
		{"permission", []string{permission}, 126},
	} {
		t.Run(command.name, func(t *testing.T) {
			f := execTestSupervisor(t, command.argv...)
			watch := execTestWatch(t, f.dir, f.nonce)
			if reply := execTestWatchPulse(t, watch); !reply.OK || reply.State != "ready" {
				t.Fatalf("readiness: %+v", reply)
			}
			reply := execTestControl(t, f, "launch")
			if !reply.OK {
				t.Fatalf("launch: %+v", reply)
			}
			reply = execTestWatchPulse(t, watch)
			deadline := time.Now().Add(2 * time.Second)
			for reply.OK && !reply.Joined && time.Now().Before(deadline) {
				reply = execTestWatchPulse(t, watch)
			}
			if !reply.OK || !reply.Joined || reply.ExitCode == nil || *reply.ExitCode != command.code {
				t.Fatalf("completion: %+v", reply)
			}
			execTestWatchExit(t, watch, 0)
			select {
			case err := <-f.done:
				failure, ok := err.(*exec.ExitError)
				if !ok || failure.ExitCode() != command.code {
					t.Fatalf("supervisor exit: %v", err)
				}
				f.done <- err
			case <-time.After(2 * time.Second):
				t.Fatal("watch did not collect the supervisor")
			}
		})
	}
}
