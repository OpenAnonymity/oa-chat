package main

import "golang.org/x/sys/unix"

func flushTerminalInput(fd int) error {
	// TIOCFLUSH takes the FREAD bit from Darwin's sys/fcntl.h. x/sys/unix
	// exposes the ioctl but not this flag; leave pending output untouched.
	const fread = 0x00000001
	return unix.IoctlSetPointerInt(fd, unix.TIOCFLUSH, fread)
}
