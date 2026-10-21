//go:build unix

package clyops

import "syscall"

// fdIsOpen reports whether descriptor fd is open in this process.
func fdIsOpen(fd int) bool {
	var st syscall.Stat_t
	return syscall.Fstat(fd, &st) == nil
}

// writeFd writes b to fd without wrapping it in an *os.File, whose finalizer would close the
// runner's descriptor. Errors (the reader went away) are ignored: a declared descriptor is optional.
func writeFd(fd int, b []byte) {
	for len(b) > 0 {
		n, err := syscall.Write(fd, b)
		if err == syscall.EINTR {
			continue
		}
		if err != nil || n <= 0 {
			return
		}
		b = b[n:]
	}
}
