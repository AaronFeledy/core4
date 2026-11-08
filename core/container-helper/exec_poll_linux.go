package main

import (
	"syscall"
	"unsafe"
)

func execControlHungup(fd int) (bool, error) {
	// Linux pollfd ABI; events=0 observes HUP/ERR even with unread DATA.
	poll := struct {
		fd      int32
		events  int16
		revents int16
	}{fd: int32(fd)}
	timeout := syscall.Timespec{}
	_, _, errno := syscall.Syscall6(syscall.SYS_PPOLL, uintptr(unsafe.Pointer(&poll)), 1,
		uintptr(unsafe.Pointer(&timeout)), 0, 0, 0)
	if errno != 0 && errno != syscall.EINTR {
		return false, errno
	}
	return poll.revents&(0x10|0x08|0x20) != 0, nil
}
