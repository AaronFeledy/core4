package main

import (
	"bytes"
	"encoding/json"
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
