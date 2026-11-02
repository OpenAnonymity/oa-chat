package relay

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"strconv"
	"time"
)

// dialSOCKS5 sends domain names to the proxy, so the local resolver never sees
// destination names. A failed proxy handshake never falls back to direct TCP.
func dialSOCKS5(ctx context.Context, proxyAddress, network, destination string) (net.Conn, error) {
	return dialSOCKS5Auth(ctx, proxyAddress, network, destination, "")
}

func dialSOCKS5Auth(ctx context.Context, proxyAddress, network, destination, identity string) (net.Conn, error) {
	if network != "tcp" {
		return nil, errors.New("SOCKS5 requires TCP")
	}
	host, portText, err := net.SplitHostPort(destination)
	if err != nil {
		return nil, errors.New("invalid SOCKS5 destination")
	}
	port, err := strconv.ParseUint(portText, 10, 16)
	if err != nil || port == 0 {
		return nil, errors.New("invalid SOCKS5 destination port")
	}
	addressType := byte(3)
	address := []byte(host)
	if ip := net.ParseIP(host); ip != nil {
		if ip4 := ip.To4(); ip4 != nil {
			addressType, address = 1, ip4
		} else {
			addressType, address = 4, ip.To16()
		}
	} else if len(address) == 0 || len(address) > 255 {
		return nil, errors.New("invalid SOCKS5 destination name")
	}
	conn, err := (&net.Dialer{Timeout: 20 * time.Second}).DialContext(ctx, "tcp", proxyAddress)
	if err != nil {
		return nil, errors.New("SOCKS5 proxy unavailable")
	}
	ok := false
	defer func() {
		if !ok {
			conn.Close()
		}
	}()
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()
	if err := conn.SetDeadline(time.Now().Add(20 * time.Second)); err != nil {
		return nil, err
	}
	method := byte(0)
	if identity != "" {
		if len(identity) > 255 {
			return nil, errors.New("invalid Tor isolation identity")
		}
		method = 2 // RFC 1929; never offer no-auth as a Tor fallback.
	}
	if _, err := io.Copy(conn, bytes.NewReader([]byte{5, 1, method})); err != nil {
		return nil, errors.New("SOCKS5 greeting failed")
	}
	var reply [4]byte
	if _, err := io.ReadFull(conn, reply[:2]); err != nil || reply[0] != 5 || reply[1] != method {
		return nil, errors.New("SOCKS5 proxy rejected required authentication method")
	}
	if method == 2 {
		auth := append([]byte{1, byte(len(identity))}, []byte(identity)...)
		auth = append(auth, 1, 'x')
		if _, err := io.Copy(conn, bytes.NewReader(auth)); err != nil {
			return nil, errors.New("Tor isolation authentication failed")
		}
		if _, err := io.ReadFull(conn, reply[:2]); err != nil || reply[0] != 1 || reply[1] != 0 {
			return nil, errors.New("Tor isolation authentication rejected")
		}
	}
	request := []byte{5, 1, 0, addressType}
	if addressType == 3 {
		request = append(request, byte(len(address)))
	}
	request = append(request, address...)
	request = append(request, byte(port>>8), byte(port))
	if _, err := io.Copy(conn, bytes.NewReader(request)); err != nil {
		return nil, errors.New("SOCKS5 connect request failed")
	}
	if _, err := io.ReadFull(conn, reply[:]); err != nil || reply[0] != 5 || reply[1] != 0 || reply[2] != 0 {
		return nil, errors.New("SOCKS5 connect failed")
	}
	remaining := 0
	switch reply[3] {
	case 1:
		remaining = 4
	case 4:
		remaining = 16
	case 3:
		var length [1]byte
		if _, err := io.ReadFull(conn, length[:]); err != nil {
			return nil, errors.New("SOCKS5 connect reply truncated")
		}
		remaining = int(length[0])
	default:
		return nil, errors.New("SOCKS5 connect reply invalid")
	}
	if _, err := io.CopyN(io.Discard, conn, int64(remaining+2)); err != nil {
		return nil, errors.New("SOCKS5 connect reply truncated")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := conn.SetDeadline(time.Time{}); err != nil {
		return nil, err
	}
	ok = true
	return conn, nil
}
