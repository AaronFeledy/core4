package main

import (
	"bytes"
	"errors"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestExecRunBoundsUnreadStdinAndCancelsOnHangup(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "ready")
	f := execRunStart(t, "/bin/sh", "-c", "trap '' TERM; echo ready > "+marker+"; while :; do sleep 1; done")
	execTestWaitFile(t, marker)
	// Use the pipe directly so the test can observe backpressure without a
	// blocked writer goroutine. Closing this writer models an attach abort.
	fd := int(f.stdin.(interface{ Fd() uintptr }).Fd())
	if err := syscall.SetNonblock(fd, true); err != nil {
		t.Fatal(err)
	}
	frame := execEncodeFrame(execFrameData, bytes.Repeat([]byte("x"), execFrameMaxData))
	written, offset := 0, 0
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && written < 16*1024*1024 {
		n, err := syscall.Write(fd, frame[offset:])
		if n > 0 {
			written += n
			offset = (offset + n) % len(frame)
		}
		if errors.Is(err, syscall.EAGAIN) {
			time.Sleep(time.Millisecond)
		} else if err != nil {
			t.Fatal(err)
		}
	}
	// Bounded consumption proves the pending DATA cannot grow with input size;
	// allow another frame and the kernel pipe beyond the 1 MiB pending limit.
	if written > 1024*1024+2*execFrameMaxData {
		t.Errorf("unread stdin consumed %d bytes without backpressure", written)
	}
	if err := f.stdin.Close(); err != nil {
		t.Fatal(err)
	}
	if state := execRunWait(t, f, 2*time.Second); state.ExitCode() != 143 {
		t.Fatalf("exit=%d stderr=%q", state.ExitCode(), f.stderr.String())
	}
}
