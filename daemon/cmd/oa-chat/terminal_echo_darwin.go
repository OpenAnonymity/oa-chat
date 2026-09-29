package main

import "golang.org/x/sys/unix"

func disableTerminalEcho(fd int) (func(), error) {
	state, err := unix.IoctlGetTermios(fd, unix.TIOCGETA)
	if err != nil {
		return nil, err
	}
	noEcho := *state
	noEcho.Lflag &^= unix.ECHO | unix.ECHONL
	if err := unix.IoctlSetTermios(fd, unix.TIOCSETA, &noEcho); err != nil {
		return nil, err
	}
	return func() { _ = unix.IoctlSetTermios(fd, unix.TIOCSETA, state) }, nil
}
