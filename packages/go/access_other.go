//go:build !unix

package clyops

import "os"

// accessible approximates access(2) where it doesn't exist: the path exists
// and, for writing, isn't read-only.
func accessible(path string, mode uint32) bool {
	st, err := os.Stat(path)
	if err != nil {
		return false
	}
	return mode&2 == 0 || st.Mode().Perm()&0o200 != 0
}
