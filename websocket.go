package main

// Minimal RFC 6455 server transport for the RK Companion's uncompressed,
// masked text frames, outbound binary snapshots and text combat events.
// Intentionally standard-library-only for fully offline reproducible builds.
// Uses no proprietary code or executable extraction.

import (
	"bufio"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	wsText     byte = 1
	wsBinary   byte = 2
	wsClose    byte = 8
	wsPing     byte = 9
	wsPong     byte = 10
	maxMessage      = 16 * 1024
)

type webSocket struct {
	conn   net.Conn
	reader *bufio.Reader
	sendMu sync.Mutex
	once   sync.Once
	done   chan struct{}
	client bool
	limit  int
}

func (ws *webSocket) maxLen() int {
	if ws.limit > 0 {
		return ws.limit
	}
	return maxMessage
}

func dialWS(addr, path string, header http.Header, timeout time.Duration) (*webSocket, error) {
	conn, err := net.DialTimeout("tcp", addr, timeout)
	if err != nil {
		return nil, err
	}
	_ = conn.SetDeadline(time.Now().Add(timeout))
	var raw [16]byte
	_, _ = rand.Read(raw[:])
	key := base64.StdEncoding.EncodeToString(raw[:])
	var req strings.Builder
	fmt.Fprintf(&req, "GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n", path, addr, key)
	for k, v := range header {
		fmt.Fprintf(&req, "%s: %s\r\n", k, v[0])
	}
	req.WriteString("\r\n")
	if _, err := conn.Write([]byte(req.String())); err != nil {
		conn.Close()
		return nil, err
	}
	reader := bufio.NewReader(conn)
	resp, err := http.ReadResponse(reader, nil)
	if err != nil {
		conn.Close()
		return nil, err
	}
	sum := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	if resp.StatusCode != http.StatusSwitchingProtocols || resp.Header.Get("Sec-WebSocket-Accept") != base64.StdEncoding.EncodeToString(sum[:]) {
		conn.Close()
		return nil, errors.New("websocket upgrade refused")
	}
	_ = conn.SetDeadline(time.Time{})
	return &webSocket{conn: conn, reader: reader, done: make(chan struct{}), client: true, limit: peerMaxMessage}, nil
}

func containsToken(header, token string) bool {
	for _, part := range strings.Split(header, ",") {
		if strings.EqualFold(strings.TrimSpace(part), token) {
			return true
		}
	}
	return false
}

func upgradeWS(w http.ResponseWriter, r *http.Request) (*webSocket, error) {
	if r.Method != http.MethodGet || !containsToken(r.Header.Get("Connection"), "upgrade") ||
		!strings.EqualFold(r.Header.Get("Upgrade"), "websocket") ||
		r.Header.Get("Sec-WebSocket-Version") != "13" {
		http.Error(w, "WebSocket protocol version 13 required", http.StatusBadRequest)
		return nil, errors.New("invalid websocket upgrade")
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	decoded, err := base64.StdEncoding.DecodeString(key)
	if err != nil || len(decoded) != 16 {
		http.Error(w, "invalid websocket key", http.StatusBadRequest)
		return nil, errors.New("invalid websocket key")
	}
	hij, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "WebSocket unsupported", 500)
		return nil, errors.New("hijacker unavailable")
	}
	conn, rw, err := hij.Hijack()
	if err != nil {
		return nil, err
	}
	sum := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	accept := base64.StdEncoding.EncodeToString(sum[:])
	_, err = fmt.Fprintf(rw, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", accept)
	if err == nil {
		err = rw.Flush()
	}
	if err != nil {
		conn.Close()
		return nil, err
	}
	return &webSocket{conn: conn, reader: rw.Reader, done: make(chan struct{})}, nil
}

func (ws *webSocket) close() {
	ws.once.Do(func() {
		close(ws.done)
		_ = ws.conn.Close()
	})
}

func (ws *webSocket) writeFrame(op byte, data []byte) error {
	ws.sendMu.Lock()
	defer ws.sendMu.Unlock()
	_ = ws.conn.SetWriteDeadline(time.Now().Add(3 * time.Second))
	n := len(data)
	var maskBit byte
	if ws.client {
		maskBit = 0x80
	}
	frame := make([]byte, 0, n+14)
	frame = append(frame, 0x80|op)
	switch {
	case n < 126:
		frame = append(frame, maskBit|byte(n))
	case n <= 65535:
		frame = append(frame, maskBit|126, byte(n>>8), byte(n))
	default:
		frame = append(frame, maskBit|127)
		frame = binary.BigEndian.AppendUint64(frame, uint64(n))
	}
	if ws.client {
		var mask [4]byte
		_, _ = rand.Read(mask[:])
		frame = append(frame, mask[:]...)
		for i, b := range data {
			frame = append(frame, b^mask[i&3])
		}
	} else {
		frame = append(frame, data...)
	}
	_, err := ws.conn.Write(frame)
	return err
}

func (ws *webSocket) closeWith(code uint16, reason string) {
	if len(reason) > 115 {
		reason = reason[:115]
	}
	d := make([]byte, 2+len(reason))
	binary.BigEndian.PutUint16(d, code)
	copy(d[2:], reason)
	_ = ws.writeFrame(wsClose, d)
	ws.close()
}

func (ws *webSocket) readFrame() (byte, []byte, error) {
	var hdr [2]byte
	if _, err := io.ReadFull(ws.reader, hdr[:]); err != nil {
		return 0, nil, err
	}
	if hdr[0]&0x70 != 0 {
		return 0, nil, errors.New("reserved websocket bits set")
	}
	opcode := hdr[0] & 0x0f
	fin := hdr[0]&0x80 != 0
	masked := hdr[1]&0x80 != 0
	if masked == ws.client {
		return 0, nil, errors.New("invalid websocket frame masking")
	}
	length := uint64(hdr[1] & 0x7f)
	if length == 126 {
		var x [2]byte
		if _, err := io.ReadFull(ws.reader, x[:]); err != nil {
			return 0, nil, err
		}
		length = uint64(binary.BigEndian.Uint16(x[:]))
	} else if length == 127 {
		var x [8]byte
		if _, err := io.ReadFull(ws.reader, x[:]); err != nil {
			return 0, nil, err
		}
		length = binary.BigEndian.Uint64(x[:])
		if length>>63 != 0 {
			return 0, nil, errors.New("invalid websocket frame size")
		}
	}
	if opcode >= 8 && (!fin || length > 125) {
		return 0, nil, errors.New("invalid control frame")
	}
	if length > uint64(ws.maxLen()) {
		return 0, nil, errors.New("websocket message exceeds size limit")
	}
	var mask [4]byte
	if masked {
		if _, err := io.ReadFull(ws.reader, mask[:]); err != nil {
			return 0, nil, err
		}
	}
	data := make([]byte, int(length))
	if _, err := io.ReadFull(ws.reader, data); err != nil {
		return 0, nil, err
	}
	if masked {
		for i := range data {
			data[i] ^= mask[i&3]
		}
	}
	if !fin {
		opcode |= 0x80
	} // caller handles continuation
	return opcode, data, nil
}

// readMessage processes ping/pong/close and accepts fragmented text frames.
func (ws *webSocket) readMessage(onPong func()) (byte, []byte, error) {
	var data []byte
	var messageType byte
	for {
		op, frag, err := ws.readFrame()
		if err != nil {
			return 0, nil, err
		}
		unfinished := op&0x80 != 0
		op &= 0x7f
		switch op {
		case wsPing:
			if err := ws.writeFrame(wsPong, frag); err != nil {
				return 0, nil, err
			}
			continue
		case wsPong:
			onPong()
			continue
		case wsClose:
			code := uint16(1000)
			if len(frag) >= 2 {
				code = binary.BigEndian.Uint16(frag)
			}
			ws.closeWith(code, "")
			return 0, nil, io.EOF
		case wsText, wsBinary:
			if messageType != 0 {
				return 0, nil, errors.New("nested message")
			}
			messageType = op
		case 0:
			if messageType == 0 {
				return 0, nil, errors.New("unexpected continuation")
			}
		default:
			return 0, nil, errors.New("invalid opcode")
		}
		if len(data)+len(frag) > ws.maxLen() {
			return 0, nil, errors.New("websocket message too large")
		}
		data = append(data, frag...)
		if !unfinished {
			return messageType, data, nil
		}
	}
}
