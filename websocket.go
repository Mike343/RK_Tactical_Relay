package main

// Minimal RFC 6455 server transport for the RK Companion's uncompressed,
// masked text frames, outbound binary snapshots and text combat events.
// Intentionally standard-library-only for fully offline reproducible builds.
// Uses no proprietary code or executable extraction.

import (
	"bufio"
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
	return &webSocket{conn: conn, reader: rw.Reader}, nil
}

func (ws *webSocket) close() { ws.once.Do(func() { _ = ws.conn.Close() }) }

func (ws *webSocket) writeFrame(op byte, data []byte) error {
	ws.sendMu.Lock()
	defer ws.sendMu.Unlock()
	if len(data) > 65535 && op != wsBinary {
		return errors.New("outbound frame too large")
	}
	_ = ws.conn.SetWriteDeadline(time.Now().Add(3 * time.Second))
	hdr := []byte{0x80 | op, 0}
	n := len(data)
	switch {
	case n < 126:
		hdr[1] = byte(n)
	case n <= 65535:
		hdr[1] = 126
		tmp := make([]byte, 2)
		binary.BigEndian.PutUint16(tmp, uint16(n))
		hdr = append(hdr, tmp...)
	default:
		hdr[1] = 127
		tmp := make([]byte, 8)
		binary.BigEndian.PutUint64(tmp, uint64(n))
		hdr = append(hdr, tmp...)
	}
	if _, err := ws.conn.Write(hdr); err != nil {
		return err
	}
	if n > 0 {
		_, err := ws.conn.Write(data)
		return err
	}
	return nil
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
	if !masked {
		return 0, nil, errors.New("unmasked client websocket frame")
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
	if length > maxMessage {
		return 0, nil, errors.New("websocket message exceeds 16K limit")
	}
	var mask [4]byte
	if _, err := io.ReadFull(ws.reader, mask[:]); err != nil {
		return 0, nil, err
	}
	data := make([]byte, int(length))
	if _, err := io.ReadFull(ws.reader, data); err != nil {
		return 0, nil, err
	}
	for i := range data {
		data[i] ^= mask[i&3]
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
		if len(data)+len(frag) > maxMessage {
			return 0, nil, errors.New("websocket message too large")
		}
		data = append(data, frag...)
		if !unfinished {
			return messageType, data, nil
		}
	}
}
