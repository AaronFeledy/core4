package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

func TestExecWatchProcess(t *testing.T) {
	if os.Getenv("LANDO_TEST_EXEC_WATCH") != "1" {
		return
	}
	for i, arg := range os.Args {
		if arg == "--" {
			os.Exit(runExecControl(os.Args[i+1:], helperIO{os.Stdin, os.Stdout, os.Stderr, nil}))
		}
	}
	os.Exit(125)
}

type execWatchFixture struct {
	input   io.WriteCloser
	output  io.ReadCloser
	decoder *json.Decoder
	cmd     *exec.Cmd
	done    chan error
	nextSeq int64
}

func execTestWatch(t *testing.T, dir, nonce string) *execWatchFixture {
	t.Helper()
	binary, _ := os.Executable()
	cmd := exec.Command(binary, "-test.run=^TestExecWatchProcess$", "--", dir, nonce, "watch")
	cmd.Env = append(os.Environ(), "LANDO_TEST_EXEC_WATCH=1")
	input, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	f := &execWatchFixture{input, output, json.NewDecoder(output), cmd, make(chan error, 1), 1}
	go func() { f.done <- cmd.Wait() }()
	t.Cleanup(func() {
		input.Close()
		select {
		case <-f.done:
		case <-time.After(5 * time.Second):
			cmd.Process.Kill()
			<-f.done
		}
		output.Close()
	})
	return f
}
func execTestWatchPulse(t *testing.T, f *execWatchFixture) execReply {
	t.Helper()
	if _, err := fmt.Fprintf(f.input, "{\"op\":\"status\",\"seq\":%d}\n", f.nextSeq); err != nil {
		t.Fatal(err)
	}
	var r execWatchReply
	if err := f.decoder.Decode(&r); err != nil {
		t.Fatal(err)
	}
	if r.Seq != f.nextSeq {
		t.Fatalf("replyseq%d wanted%d", r.Seq, f.nextSeq)
	}
	f.nextSeq++
	return r.execReply
}
func execTestWatchExit(t *testing.T, f *execWatchFixture, want int) {
	t.Helper()
	select {
	case err := <-f.done:
		code := 0
		if err != nil {
			e, ok := err.(*exec.ExitError)
			if !ok {
				t.Fatal(err)
			}
			code = e.ExitCode()
		}
		if code != want {
			t.Fatalf("watch exit %d wanted%d", code, want)
		}
		f.done <- err
	case <-time.After(5 * time.Second):
		t.Fatal("watch did not exit")
	}
}
func execTestWatchServer(t *testing.T, terminalAfter int64) (string, string, *atomic.Int64) {
	t.Helper()
	nonce := strings.Repeat("a", 32)
	// Each test owns its private session directory; randomize with a temp suffix's hash.
	temp := t.TempDir()
	sum := sha256ForWatchTest(temp)
	nonce = sum[:32]
	dir := "/tmp/lando-exec-session-" + nonce
	if err := execPrivateDirectory(dir); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("unix", filepath.Join(dir, "control"))
	if err != nil {
		t.Fatal(err)
	}
	count := new(atomic.Int64)
	go func() {
		for {
			conn, e := listener.Accept()
			if e != nil {
				return
			}
			func() {
				defer conn.Close()
				var req execRequest
				if json.NewDecoder(conn).Decode(&req) != nil {
					return
				}
				n := count.Add(1)
				r := execReply{OK: true, State: "running"}
				if terminalAfter > 0 && n == terminalAfter {
					code := 23
					r = execReply{OK: true, State: "finished", Joined: true, ExitCode: &code}
				}
				json.NewEncoder(conn).Encode(r)
			}()
		}
	}()
	t.Cleanup(func() { listener.Close(); os.RemoveAll(dir) })
	return dir, nonce, count
}
func sha256ForWatchTest(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
func TestExecWatchHundredsOfPulsesUseOneProcess(t *testing.T) {
	dir, nonce, count := execTestWatchServer(t, 300)
	f := execTestWatch(t, dir, nonce)
	pid := f.cmd.Process.Pid
	for i := 0; i < 300; i++ {
		r := execTestWatchPulse(t, f)
		if !r.OK || r.Joined != (i == 299) {
			t.Fatalf("receipt%d %+v", i, r)
		}
		if f.cmd.Process.Pid != pid {
			t.Fatal("watch process changed")
		}
	}
	execTestWatchExit(t, f, 0)
	if count.Load() != 300 {
		t.Fatalf("status exchanges %d", count.Load())
	}
}
func TestExecWatchRejectsMalformedInput(t *testing.T) {
	for name, input := range map[string]string{"zero-seq": "{\"op\":\"status\",\"seq\":0}\n", "negative-seq": "{\"op\":\"status\",\"seq\":-1}\n", "fraction-seq": "{\"op\":\"status\",\"seq\":1.5}\n", "unsafe-seq": "{\"op\":\"status\",\"seq\":9007199254740992}\n", "out-of-order-seq": "{\"op\":\"status\",\"seq\":2}\n", "missing-seq": "{\"op\":\"status\"}\n", "wrong-op": "{\"op\":\"launch\",\"seq\":1}\n", "duplicate-op": "{\"op\":\"status\",\"op\":\"status\",\"seq\":1}\n", "unknown-field": "{\"op\":\"status\",\"x\":1}\n", "non-ascii": "{\"op\":\"stat\xffus\"}\n", "oversized": strings.Repeat(" ", 4097), "partial": "{\"op\":", "two-inflight": "{\"op\":\"status\",\"seq\":1}\n{\"op\":\"status\",\"seq\":1}\n", "terminal-trailing-partial": "{\"op\":\"status\",\"seq\":1}\n{"} {
		t.Run(name, func(t *testing.T) {
			dir, nonce, count := execTestWatchServer(t, 1)
			f := execTestWatch(t, dir, nonce)
			io.WriteString(f.input, input)
			f.input.Close()
			var r execReply
			if err := f.decoder.Decode(&r); err != nil {
				t.Fatal(err)
			}
			if r.OK {
				t.Fatalf("invalid input accepted %+v", r)
			}
			execTestWatchExit(t, f, 1)
			if count.Load() != 0 {
				t.Fatalf("invalid pulse renewed lease %d", count.Load())
			}
		})
	}
}
func TestExecWatchImmediateFinishedReceipt(t *testing.T) {
	dir, nonce, _ := execTestWatchServer(t, 1)
	f := execTestWatch(t, dir, nonce)
	r := execTestWatchPulse(t, f)
	if !r.Joined || r.ExitCode == nil || *r.ExitCode != 23 {
		t.Fatalf("receipt %+v", r)
	}
	execTestWatchExit(t, f, 0)
}
func TestExecWatchEOFAndIdleDoNotRenewSupervisorLease(t *testing.T) {
	for _, mode := range []string{"eof", "idle"} {
		t.Run(mode, func(t *testing.T) {
			marker := filepath.Join(t.TempDir(), "ready")
			f := execTestSupervisor(t, "/bin/sh", "-c", "trap '' TERM; echo $$ > "+marker+"; while :; do sleep 1; done")
			watch := execTestWatch(t, f.dir, f.nonce)
			if r := execTestWatchPulse(t, watch); r.State != "ready" {
				t.Fatalf("prelaunch %+v", r)
			}
			if r := execTestControl(t, f, "launch"); !r.OK {
				t.Fatalf("launch %+v", r)
			}
			execTestWaitFile(t, marker)
			if r := execTestWatchPulse(t, watch); r.State != "running" {
				t.Fatalf("running %+v", r)
			}
			drained := make(chan struct{})
			go func() { io.Copy(io.Discard, watch.output); close(drained) }()
			if mode == "eof" {
				watch.input.Close()
			}
			execTestWatchExit(t, watch, 0)
			select {
			case <-drained:
			case <-time.After(time.Second):
				t.Fatal("watch stdout did not close")
			}
			select {
			case err := <-f.done:
				if e, ok := err.(*exec.ExitError); !ok || e.ExitCode() != 137 {
					t.Fatalf("lease exit %v", err)
				}
				f.done <- err
			case <-time.After(12 * time.Second):
				t.Fatal("watch renewed lease without host pulse")
			}
			r, ok := execLoad(f.dir)
			if !ok || !r.OK || !r.Joined {
				t.Fatalf("lease receipt %+v", r)
			}
		})
	}
}
func TestExecWatchDisconnectPreservesExplicitINT(t *testing.T) {
	ready := filepath.Join(t.TempDir(), "ready")
	received := filepath.Join(t.TempDir(), "signal")
	f := execTestSupervisor(t, "/bin/sh", "-c", "trap 'printf INT > "+received+"; exit 42' INT; trap 'printf TERM > "+received+"; exit 43' TERM; echo ready > "+ready+"; while :; do sleep 1; done")
	if r := execTestControl(t, f, "launch"); !r.OK {
		t.Fatal(r)
	}
	execTestWaitFile(t, ready)
	watch := execTestWatch(t, f.dir, f.nonce)
	execTestWatchPulse(t, watch)
	watch.input.Close()
	io.Copy(io.Discard, watch.output)
	execTestWatchExit(t, watch, 0)
	var out bytes.Buffer
	runExecControl([]string{f.dir, f.nonce, "cancel", "SIGINT"}, helperIO{stdout: &out})
	var r execReply
	json.Unmarshal(out.Bytes(), &r)
	if !r.OK || r.ExitCode == nil || *r.ExitCode != 42 {
		t.Fatalf("INT result %+v", r)
	}
	if b := execTestWaitFile(t, received); string(b) != "INT" {
		t.Fatalf("signal %q", b)
	}
}

func TestExecWatchRejectsRepeatedSequenceWithoutRenewal(t *testing.T) {
	dir, nonce, count := execTestWatchServer(t, 0)
	f := execTestWatch(t, dir, nonce)
	if r := execTestWatchPulse(t, f); !r.OK {
		t.Fatal(r)
	}
	io.WriteString(f.input, "{\"op\":\"status\",\"seq\":1}\n")
	var r execWatchReply
	if err := f.decoder.Decode(&r); err != nil {
		t.Fatal(err)
	}
	if r.OK || r.Seq != 2 {
		t.Fatalf("repeatedseq accepted %+v", r)
	}
	execTestWatchExit(t, f, 1)
	if count.Load() != 1 {
		t.Fatalf("badseq renewedlease%d", count.Load())
	}
}
func TestExecWatchStalledOutputHasBoundedPulseLifetime(t *testing.T) {
	dir, _, count := execTestWatchServer(t, 1)
	inRead, inWrite, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer inRead.Close()
	defer inWrite.Close()
	outRead, outWrite, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer outRead.Close()
	defer outWrite.Close()
	outFD := int(outWrite.Fd())
	if err = syscall.SetNonblock(outFD, true); err != nil {
		t.Fatal(err)
	}
	padding := make([]byte, 4096)
	for {
		_, err = syscall.Write(outFD, padding)
		if err == syscall.EAGAIN {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	io.WriteString(inWrite, "{\"op\":\"status\",\"seq\":1}\n")
	started := time.Now()
	code := runExecWatch(dir, helperIO{stdin: inRead, stdout: outWrite})
	elapsed := time.Since(started)
	if code != 1 || elapsed > 2500*time.Millisecond {
		t.Fatalf("stalledwatch code%d elapsed%v", code, elapsed)
	}
	if count.Load() != 1 {
		t.Fatalf("stalledwatch queries%d", count.Load())
	}
}
