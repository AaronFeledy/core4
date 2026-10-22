package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"time"
)

func protocolFixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestOpenRequestsMatchSharedFixtures(t *testing.T) {
	for _, fixture := range []struct {
		name   string
		target string
	}{
		{"open-url-request.jsonl", "https://example.com/x?a=1&b=two"},
		{"open-path-request.jsonl", "/app/README"},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			call, err := openCall([]string{fixture.target})
			if err != nil {
				t.Fatal(err)
			}
			var encoded bytes.Buffer
			encoder := json.NewEncoder(&encoded)
			encoder.SetEscapeHTML(false)
			if err := encoder.Encode(call.payload); err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(encoded.Bytes(), protocolFixture(t, fixture.name)) {
				t.Fatalf("request=%s", encoded.Bytes())
			}
		})
	}
}

func TestRunLandoRequestMatchesSharedFixture(t *testing.T) {
	want := bytes.TrimSpace(protocolFixture(t, "run-lando-request.jsonl"))
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir("/tmp"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(cwd); err != nil {
			t.Error(err)
		}
	})
	oldNames := forwardNames
	forwardNames = "LANG,TERM"
	t.Cleanup(func() { forwardNames = oldNames })
	received := make(chan []byte, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
		}
		received <- body
		if _, err := io.WriteString(w, "{\"kind\":\"exit\",\"code\":0}\n"); err != nil {
			t.Error(err)
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var stdout, stderr bytes.Buffer
	env := map[string]string{
		"LANDO_HOST_PROXY_URL": server.URL, "LANDO_HOST_PROXY_SESSION": "session",
		"LANDO_HOST_PROXY_APP": "app", "LANDO_HOST_PROXY_TOKEN": "token",
		"LANG": "C.UTF-8", "TERM": "xterm-256color", "SECRET_TOKEN": "not-forwarded",
	}

	code := runHostProxy(ctx, []string{"info", "a b", ""}, helperIO{strings.NewReader(""), &stdout, &stderr, env})

	if code != 0 || stderr.Len() != 0 {
		t.Fatalf("code=%d stderr=%q", code, stderr.String())
	}
	if got := <-received; !bytes.Equal(got, want) {
		t.Fatalf("request = %s; want %s", got, want)
	}
}

func TestLogFileCommandsMatchSharedFixtures(t *testing.T) {
	lines := bytes.Split(bytes.TrimSpace(protocolFixture(t, "log-file-requests.jsonl")), []byte("\n"))
	want := []logCommand{
		{op: "stat", path: "protocol.log"}, {op: "open", path: "protocol.log"},
		{op: "fstat"}, {op: "read", offset: "7", maxBytes: 100}, {op: "close"},
	}
	if len(lines) != len(want) {
		t.Fatalf("got %d command frames; want %d", len(lines), len(want))
	}
	for i, line := range lines {
		got, response := decodeCommand(line)
		if !response.OK || !reflect.DeepEqual(got, want[i]) {
			t.Fatalf("frame %d: command=%+v response=%+v", i, got, response)
		}
	}
}

func TestLogFileResponsesMatchSharedFixtures(t *testing.T) {
	want := protocolFixture(t, "log-file-responses.jsonl")
	path := filepath.Join(t.TempDir(), "protocol.log")
	if err := os.WriteFile(path, []byte("line-1\nline-2\n"), 0600); err != nil {
		t.Fatal(err)
	}
	file := &logFile{}
	t.Cleanup(func() {
		if err := file.close(); err != nil {
			t.Error(err)
		}
	})
	if response := file.run(logCommand{op: "open", path: path}); !response.OK {
		t.Fatalf("open failed: %+v", response)
	}
	stat := statResponse(syscall.Stat_t{Dev: 1, Ino: 2, Size: 14})
	responses := []logResponse{stat, stat, stat, file.run(logCommand{op: "read", offset: "7", maxBytes: 100}), file.run(logCommand{op: "close"})}
	var got bytes.Buffer
	for _, response := range responses {
		if err := json.NewEncoder(&got).Encode(response); err != nil {
			t.Fatal(err)
		}
	}
	if !bytes.Equal(got.Bytes(), want) {
		t.Fatalf("responses = %s; want %s", got.Bytes(), want)
	}
}
