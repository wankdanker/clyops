//go:build unix

package clyops

import "syscall"

// accessible reports whether the process may access path with mode (4 read, 2 write).
func accessible(path string, mode uint32) bool { return syscall.Access(path, mode) == nil }
