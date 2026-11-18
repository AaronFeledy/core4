//go:build linux

package main

import (
	"runtime"
	"syscall"
	"unsafe"
)

const renameNoReplaceFlag = 0x1

var atFDCWD = -100

// renameNoReplace is renameat2(RENAME_NOREPLACE). It atomically moves a file,
// symlink, or directory and fails with EEXIST instead of replacing the
// destination, which is how promotion proves it never overwrote a path another
// writer created after the manifest snapshot.
func renameNoReplace(oldPath string, newPath string) error {
	oldPointer, err := syscall.BytePtrFromString(oldPath)
	if err != nil {
		return err
	}
	newPointer, err := syscall.BytePtrFromString(newPath)
	if err != nil {
		return err
	}
	_, _, errno := syscall.Syscall6(
		sysRenameat2,
		uintptr(atFDCWD),
		uintptr(unsafe.Pointer(oldPointer)),
		uintptr(atFDCWD),
		uintptr(unsafe.Pointer(newPointer)),
		uintptr(renameNoReplaceFlag),
		0,
	)
	runtime.KeepAlive(oldPointer)
	runtime.KeepAlive(newPointer)
	if errno != 0 {
		return errno
	}
	return nil
}
