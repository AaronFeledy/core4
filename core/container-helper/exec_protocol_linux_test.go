package main

import (
	"bytes"
	"encoding/binary"
	"testing"
)

func TestExecFrameRoundTrip(t *testing.T) {
	cases := []struct {
		name    string
		typ     byte
		payload []byte
	}{
		{"empty-data", execFrameData, nil},
		{"binary-data", execFrameData, []byte("raw\x00input\xff\n")},
		{"max-ish", execFrameData, bytes.Repeat([]byte{0x7f}, 1024)},
		{"eof", execFrameEOF, nil},
		{"sigint", execFrameSignal, []byte{execSignalInterrupt}},
		{"sigterm", execFrameSignal, []byte{execSignalTerminate}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			encoded := execEncodeFrame(tc.typ, tc.payload)
			var p execFrameParser
			if err := p.Feed(encoded); err != nil {
				t.Fatal(err)
			}
			frame, err := p.Next()
			if err != nil {
				t.Fatal(err)
			}
			if frame.Type != tc.typ || !bytes.Equal(frame.Payload, tc.payload) {
				t.Fatalf("got type=%d payload=%q", frame.Type, frame.Payload)
			}
			if _, err = p.Next(); err != errExecFrameIncomplete {
				t.Fatalf("extra frame: %v", err)
			}
		})
	}
}

func parseAll(raw []byte) error {
	var p execFrameParser
	if err := p.Feed(raw); err != nil {
		return err
	}
	for {
		_, err := p.Next()
		if err == errExecFrameIncomplete {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

func TestExecFrameRejectsInvalid(t *testing.T) {
	oversize := make([]byte, 5)
	oversize[0] = execFrameData
	binary.BigEndian.PutUint32(oversize[1:5], execFrameMaxData+1)

	for _, tc := range []struct {
		name string
		raw  []byte
	}{
		{"bad-type", []byte{9, 0, 0, 0, 0}},
		{"eof-with-payload", execEncodeFrame(execFrameEOF, []byte{1})},
		{"signal-empty", execEncodeFrame(execFrameSignal, nil)},
		{"signal-bad", execEncodeFrame(execFrameSignal, []byte{9})},
		{"signal-long", execEncodeFrame(execFrameSignal, []byte{2, 2})},
		{"oversize-len", oversize},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := parseAll(tc.raw)
			if err != errExecFrameInvalid {
				// oversize length is rejected on Next once the header is present
				var p execFrameParser
				_ = p.Feed(tc.raw)
				_, err = p.Next()
				if err != errExecFrameInvalid {
					t.Fatalf("got %v", err)
				}
			}
		})
	}
}

func TestExecFrameIncrementalFeed(t *testing.T) {
	raw := execEncodeFrame(execFrameData, []byte("abc"))
	var p execFrameParser
	for i := 0; i < len(raw)-1; i++ {
		if err := p.Feed(raw[i : i+1]); err != nil {
			t.Fatal(err)
		}
		if _, err := p.Next(); err != errExecFrameIncomplete {
			t.Fatalf("early frame at %d: %v", i, err)
		}
	}
	if err := p.Feed(raw[len(raw)-1:]); err != nil {
		t.Fatal(err)
	}
	frame, err := p.Next()
	if err != nil || string(frame.Payload) != "abc" {
		t.Fatalf("got %+v %v", frame, err)
	}
}
