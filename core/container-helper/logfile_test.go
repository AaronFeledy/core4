package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

type logSession struct {
	input  *io.PipeWriter
	output *json.Decoder
	done   chan error
}

func startLogSession(t *testing.T) *logSession {
	t.Helper()
	input, commands := io.Pipe()
	responses, output := io.Pipe()
	session := &logSession{commands, json.NewDecoder(responses), make(chan error, 1)}
	go func() {
		err := runLogFile(input, output)
		if closeErr := output.Close(); err == nil {
			err = closeErr
		}
		session.done <- err
	}()
	t.Cleanup(func() {
		if err := commands.Close(); err != nil {
			t.Error(err)
		}
		if err := <-session.done; err != nil {
			t.Error(err)
		}
		if err := responses.Close(); err != nil {
			t.Error(err)
		}
		if err := input.Close(); err != nil {
			t.Error(err)
		}
	})
	return session
}

func (s *logSession) command(t *testing.T, command string) logResponse {
	t.Helper()
	if _, err := io.WriteString(s.input, command+"\n"); err != nil {
		t.Fatal(err)
	}
	var response logResponse
	if err := s.output.Decode(&response); err != nil {
		t.Fatal(err)
	}
	return response
}

func writeLog(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(contents), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestLogFileRead(t *testing.T) {
	for _, tc := range []struct {
		name, contents, offset string
		maxBytes               int64
		want                   string
		next                   string
		eof                    bool
	}{
		{"partial", "hello", "1", 2, "el", "3", false},
		{"short", "hello", "3", 5, "lo", "5", true},
		{"exact", "hello", "0", 5, "hello", "5", false},
		{"at end", "hello", "5", 5, "", "5", true},
		{"past end", "hello", "20", 5, "", "20", true},
		{"zero", "hello", "0", 0, "", "0", false},
		{"binary", "\x00\xff\n", "0", 4, "\x00\xff\n", "3", true},
		{"clamped", strings.Repeat("x", 70000), "0", maxSafeInteger, strings.Repeat("x", 65536), "65536", false},
		{"safe boundary", "hello", "9007199254740991", 2, "", "9007199254740991", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "log")
			writeLog(t, path, tc.contents)
			s := startLogSession(t)
			if got := s.command(t, `{"op":"open","path":`+strconv.Quote(path)+`}`); !got.OK || got.Stat == nil {
				t.Fatalf("open=%+v", got)
			}
			got := s.command(t, `{"op":"read","offset":`+strconv.Quote(tc.offset)+`,"maxBytes":`+strconv.FormatInt(tc.maxBytes, 10)+`}`)
			if !got.OK || got.Bytes == nil || *got.Bytes != base64.StdEncoding.EncodeToString([]byte(tc.want)) || got.NextOffset != tc.next || got.EOF == nil || *got.EOF != tc.eof {
				t.Fatalf("read=%+v", got)
			}
		})
	}
}

func TestLogFileRotationAndTruncation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "log")
	writeLog(t, path, "original")
	s := startLogSession(t)
	opened := s.command(t, `{"op":"open","path":`+strconv.Quote(path)+`}`)
	if !opened.OK || opened.Stat == nil {
		t.Fatalf("open=%+v", opened)
	}
	if err := os.Rename(path, path+".old"); err != nil {
		t.Fatal(err)
	}
	writeLog(t, path, "new")
	current := s.command(t, `{"op":"stat","path":`+strconv.Quote(path)+`}`)
	retained := s.command(t, `{"op":"fstat"}`)
	if current.Stat == nil || retained.Stat == nil || current.Stat.Ino == opened.Stat.Ino || *retained.Stat != *opened.Stat {
		t.Fatalf("rotation current=%+v retained=%+v", current, retained)
	}
	read := s.command(t, `{"op":"read","offset":"0","maxBytes":20}`)
	if read.Bytes == nil || *read.Bytes != base64.StdEncoding.EncodeToString([]byte("original")) {
		t.Fatalf("read rotated=%+v", read)
	}
	reopened := s.command(t, `{"op":"open","path":`+strconv.Quote(path)+`}`)
	if reopened.Stat == nil || *reopened.Stat != *current.Stat {
		t.Fatalf("reopen=%+v", reopened)
	}
	if err := os.Truncate(path, 1); err != nil {
		t.Fatal(err)
	}
	truncated := s.command(t, `{"op":"fstat"}`)
	if truncated.Stat == nil || truncated.Stat.Size != "1" {
		t.Fatalf("truncate=%+v", truncated)
	}
	read = s.command(t, `{"op":"read","offset":"0","maxBytes":20}`)
	if read.Bytes == nil || *read.Bytes != "bg==" || read.EOF == nil || !*read.EOF {
		t.Fatalf("truncated read=%+v", read)
	}
}

func TestLogFileStatFollowsSymlinks(t *testing.T) {
	path := filepath.Join(t.TempDir(), "log")
	writeLog(t, path, "hello")
	if err := os.Symlink(path, path+".link"); err != nil {
		t.Fatal(err)
	}
	s := startLogSession(t)
	got := s.command(t, `{"op":"stat","path":`+strconv.Quote(path+".link")+`}`)
	var stat os.FileInfo
	stat, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !got.OK || got.Stat == nil || got.Stat.Size != strconv.FormatInt(stat.Size(), 10) {
		t.Fatalf("stat=%+v", got)
	}
	for _, number := range []string{got.Stat.Dev, got.Stat.Ino} {
		if _, err := strconv.ParseUint(number, 10, 64); err != nil {
			t.Fatal(err)
		}
	}
}

func TestLogFileHandleErrors(t *testing.T) {
	path := filepath.Join(t.TempDir(), "log")
	writeLog(t, path, "hello")
	for _, tc := range []struct {
		name          string
		commands      []string
		code, message string
	}{
		{"fstat closed", []string{`{"op":"fstat"}`}, "EBADF", "log file is not open"},
		{"read closed before range", []string{`{"op":"read","offset":"999999999999999999999999999","maxBytes":1}`}, "EBADF", "log file is not open"},
		{"close then read", []string{`{"op":"open","path":` + strconv.Quote(path) + `}`, `{"op":"close"}`, `{"op":"read","offset":"0","maxBytes":1}`}, "EBADF", "log file is not open"},
		{"range", []string{`{"op":"open","path":` + strconv.Quote(path) + `}`, `{"op":"read","offset":"9007199254740992","maxBytes":1}`}, "ERANGE", "read offset is outside the safe positional-read range"},
		{"huge range", []string{`{"op":"open","path":` + strconv.Quote(path) + `}`, `{"op":"read","offset":"999999999999999999999999999999999999","maxBytes":0}`}, "ERANGE", "read offset is outside the safe positional-read range"},
		{"failed replacement closes old", []string{`{"op":"open","path":` + strconv.Quote(path) + `}`, `{"op":"open","path":` + strconv.Quote(path+".missing") + `}`, `{"op":"fstat"}`}, "EBADF", "log file is not open"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := startLogSession(t)
			var got logResponse
			for _, cmd := range tc.commands {
				got = s.command(t, cmd)
			}
			if got.OK || got.Code != tc.code || got.Message != tc.message {
				t.Fatalf("response=%+v", got)
			}
		})
	}
}

func TestLogFileEOFIsSilent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "log")
	writeLog(t, path, "x")
	for _, newline := range []string{"", "\n", "\r\n"} {
		var out bytes.Buffer
		if err := runLogFile(strings.NewReader(`{"op":"open","path":`+strconv.Quote(path)+`}`+newline), &out); err != nil {
			t.Fatal(err)
		}
		lines := bufio.NewScanner(&out)
		count := 0
		for lines.Scan() {
			count++
		}
		if err := lines.Err(); err != nil {
			t.Fatal(err)
		}
		if count != 1 {
			t.Fatalf("EOF wrote %d responses", count)
		}
	}
}

func TestLogFileOpenClosesPreviousHandle(t *testing.T) {
	path := filepath.Join(t.TempDir(), "log")
	writeLog(t, path, "hello")
	f := &logFile{}
	t.Cleanup(func() {
		if err := f.close(); err != nil {
			t.Error(err)
		}
	})
	if got := f.run(logCommand{op: "open", path: path}); !got.OK {
		t.Fatalf("open=%+v", got)
	}
	previous := f.handle
	if got := f.run(logCommand{op: "open", path: path}); !got.OK {
		t.Fatalf("replacement=%+v", got)
	}
	if _, err := previous.Stat(); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("previous handle not closed: %v", err)
	}
	if got := f.run(logCommand{op: "close"}); !got.OK {
		t.Fatalf("close=%+v", got)
	}
	if got := f.run(logCommand{op: "close"}); !got.OK {
		t.Fatalf("repeated close=%+v", got)
	}
}
