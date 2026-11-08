package main

import (
	"encoding/binary"
	"errors"
)

// Framed stdin control protocol for exec-run:
//   1 byte type + 4 bytes big-endian uint32 length + payload.
// DATA forwards child stdin; logical EOF closes child stdin only; SIGNAL
// requests owned-tree cancellation. Raw control EOF is host disconnect.
const (
	execFrameData       byte = 0
	execFrameEOF        byte = 1
	execFrameSignal     byte = 2
	execFrameMaxData         = 65536
	execSignalInterrupt      = 2
	execSignalTerminate      = 15
	execFrameHeaderLen       = 5
)

var (
	errExecFrameIncomplete = errors.New("frame-incomplete")
	errExecFrameInvalid    = errors.New("frame-invalid")
)

type execFrame struct {
	Type    byte
	Payload []byte
}

func execFrameSignalValue(payload []byte) (byte, bool) {
	if len(payload) != 1 {
		return 0, false
	}
	switch payload[0] {
	case execSignalInterrupt, execSignalTerminate:
		return payload[0], true
	default:
		return 0, false
	}
}

func execEncodeFrame(typ byte, payload []byte) []byte {
	out := make([]byte, execFrameHeaderLen+len(payload))
	out[0] = typ
	binary.BigEndian.PutUint32(out[1:5], uint32(len(payload)))
	copy(out[5:], payload)
	return out
}

// execFrameParser accumulates bytes and yields complete validated frames.
// Keeping parse state here lets the run loop read control non-blocking without
// blocking on child-stdin backpressure between frames.
type execFrameParser struct {
	buf []byte
}

func (p *execFrameParser) Feed(chunk []byte) error {
	if len(chunk) == 0 {
		return nil
	}
	p.buf = append(p.buf, chunk...)
	// Allow pipelined frames (a complete max DATA plus the next header/body)
	// while still bounding hostile growth. Length validity is checked in Next.
	if len(p.buf) > 2*(execFrameHeaderLen+execFrameMaxData) {
		return errExecFrameInvalid
	}
	return nil
}

func (p *execFrameParser) Next() (execFrame, error) {
	if len(p.buf) < execFrameHeaderLen {
		return execFrame{}, errExecFrameIncomplete
	}
	typ := p.buf[0]
	n := binary.BigEndian.Uint32(p.buf[1:5])
	if n > execFrameMaxData {
		return execFrame{}, errExecFrameInvalid
	}
	need := execFrameHeaderLen + int(n)
	if len(p.buf) < need {
		return execFrame{}, errExecFrameIncomplete
	}
	payload := make([]byte, n)
	copy(payload, p.buf[execFrameHeaderLen:need])
	p.buf = p.buf[need:]
	switch typ {
	case execFrameData:
	case execFrameEOF:
		if n != 0 {
			return execFrame{}, errExecFrameInvalid
		}
	case execFrameSignal:
		if _, ok := execFrameSignalValue(payload); !ok {
			return execFrame{}, errExecFrameInvalid
		}
	default:
		return execFrame{}, errExecFrameInvalid
	}
	return execFrame{Type: typ, Payload: payload}, nil
}
