//go:build !unix

package clyops

// fdIsOpen is false where there are no POSIX descriptors (spec section 14).
func fdIsOpen(int) bool { return false }

func writeFd(int, []byte) {}
