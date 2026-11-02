package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
)

func TestLogCommandValidation(t *testing.T) {
	for _, line := range []string{
		`null`, `[]`, `1`, `"read"`, `{}`, `{"op":null}`, `{"op":1}`, `{"op":"unknown"}`,
		`{"op":"stat"}`, `{"op":"stat","path":null}`, `{"op":"open","path":1}`, `{"OP":"close"}`,
		`{"op":"read"}`, `{"op":"read","offset":"0"}`, `{"op":"read","offset":0,"maxBytes":1}`,
		`{"op":"read","offset":null,"maxBytes":1}`, `{"op":"read","offset":"00","maxBytes":1}`,
		`{"op":"read","offset":"01","maxBytes":1}`, `{"op":"read","offset":"-1","maxBytes":1}`,
		`{"op":"read","offset":"+1","maxBytes":1}`, `{"op":"read","offset":"1.0","maxBytes":1}`,
		`{"op":"read","offset":" 1","maxBytes":1}`, `{"op":"read","offset":"1\n","maxBytes":1}`,
		`{"op":"read","offset":"0","maxBytes":null}`, `{"op":"read","offset":"0","maxBytes":"1"}`,
		`{"op":"read","offset":"0","maxBytes":-1}`, `{"op":"read","offset":"0","maxBytes":0.1}`,
		`{"op":"read","offset":"0","maxBytes":9007199254740992}`,
		`{"op":"read","offset":"0","maxBytes":1e999}`,
	} {
		t.Run(line, func(t *testing.T) {
			var out bytes.Buffer
			if err := runLogFile(strings.NewReader(line+"\n"), &out); err != nil {
				t.Fatal(err)
			}
			if out.String() != "{\"ok\":false,\"code\":\"EPROTO\",\"message\":\"invalid helper command\"}\n" {
				t.Fatalf("response=%s", out.String())
			}
		})
	}
}

func TestLogFileParseErrorsAndRecovery(t *testing.T) {
	for _, line := range []string{"", "{", "undefined", `{"op":"close"} trailing`} {
		t.Run(line, func(t *testing.T) {
			var out bytes.Buffer
			if err := runLogFile(strings.NewReader(line+"\n{\"op\":\"close\"}\n"), &out); err != nil {
				t.Fatal(err)
			}
			decoder := json.NewDecoder(&out)
			var failure, recovered logResponse
			if err := decoder.Decode(&failure); err != nil {
				t.Fatal(err)
			}
			if err := decoder.Decode(&recovered); err != nil {
				t.Fatal(err)
			}
			if failure.OK || failure.Code != "EIO" || failure.Message == "" || !recovered.OK {
				t.Fatalf("responses=%+v %+v", failure, recovered)
			}
		})
	}
}

func TestLogFileFilesystemErrors(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "log")
	writeLog(t, path, "x")
	loop := filepath.Join(dir, "loop")
	if err := os.Symlink(loop, loop); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		op, path, code string
		missing        bool
	}{
		{"stat", path + ".absent", "", true},
		{"open", path + ".absent", "ENOENT", false},
		{"stat", path + "/child", "ENOTDIR", false},
		{"open", path + "/child", "ENOTDIR", false},
		{"stat", loop, "ELOOP", false},
		{"open", loop, "ELOOP", false},
	} {
		t.Run(tc.op+tc.path, func(t *testing.T) {
			s := startLogSession(t)
			got := s.command(t, `{"op":`+strconv.Quote(tc.op)+`,"path":`+strconv.Quote(tc.path)+`}`)
			if got.Missing != tc.missing || got.OK != tc.missing || got.Code != tc.code || (!tc.missing && got.Message == "") {
				t.Fatalf("response=%+v", got)
			}
		})
	}
	s := startLogSession(t)
	if got := s.command(t, `{"op":"open","path":`+strconv.Quote(dir)+`}`); !got.OK {
		t.Fatalf("open directory=%+v", got)
	}
	if got := s.command(t, `{"op":"read","offset":"0","maxBytes":1}`); got.Code != "EISDIR" {
		t.Fatalf("read directory=%+v", got)
	}
}

func TestLogErrnoMapping(t *testing.T) {
	for _, tc := range []struct {
		err  error
		code string
	}{
		{syscall.EACCES, "EACCES"}, {syscall.EPERM, "EPERM"}, {syscall.EISDIR, "EISDIR"}, {syscall.ENOTDIR, "ENOTDIR"},
		{syscall.ELOOP, "ELOOP"}, {syscall.ENOENT, "ENOENT"}, {syscall.EBADF, "EBADF"}, {syscall.ENOSPC, "EIO"},
	} {
		t.Run(tc.code+tc.err.Error(), func(t *testing.T) {
			got := logError(&os.PathError{Op: "open", Path: "log", Err: tc.err})
			if got.OK || got.Code != tc.code || got.Message == "" {
				t.Fatalf("response=%+v", got)
			}
		})
	}
}

func TestCleanupPathValidation(t *testing.T) {
	for _, path := range []string{"", "/tmp", "/tmp/lando-log-file-helper-", "/tmp/lando-log-file-helper-" + strings.Repeat("a", 31), "/tmp/lando-log-file-helper-" + strings.Repeat("A", 32), "/tmp/lando-log-file-helper-" + strings.Repeat("a", 32) + "/", "/tmp/lando-log-file-helper-" + strings.Repeat("a", 32) + "/../other"} {
		t.Run(path, func(t *testing.T) {
			var out bytes.Buffer
			if err := cleanupLogFile(path, &out); err != nil {
				t.Fatal(err)
			}
			if out.String() != "{\"ok\":false,\"code\":\"EPROTO\",\"message\":\"invalid helper cleanup path\"}\n" {
				t.Fatalf("response=%s", out.String())
			}
		})
	}
}

func TestCleanupRemovesDirectory(t *testing.T) {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		t.Fatal(err)
	}
	path := "/tmp/lando-log-file-helper-" + hex.EncodeToString(id[:])
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(path); err != nil {
			t.Error(err)
		}
	})
	writeLog(t, filepath.Join(path, "helper"), "binary")
	for range 2 {
		var out bytes.Buffer
		if err := cleanupLogFile(path, &out); err != nil {
			t.Fatal(err)
		}
		if out.String() != "{\"ok\":true}\n" {
			t.Fatalf("response=%s", out.String())
		}
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("cleanup left directory: %v", err)
	}
}
