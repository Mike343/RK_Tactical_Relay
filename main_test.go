package main

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSnapshotProtocol3(t *testing.T) {
	s := newRelay(config{Port: 8787})
	now := time.Now()
	viewer := &relayClient{ID: "bravo", Name: "Bravo", State: &aircraftState{Lat: 45, Lon: 0}}
	other := &relayClient{ID: "alpha", Name: "Alpha", State: &aircraftState{Lat: 40, Lon: -122, AltFt: 1234, Heading: 90, SpeedKts: 250, Aircraft: "F-18"}, LastState: now}
	s.clients[nil] = other
	b := s.snapshotFor(viewer)
	if len(b) != 3864 {
		t.Fatalf("size=%d", len(b))
	}
	for _, v := range []struct {
		off  int
		want uint32
	}{{0, magic}, {4, 4}, {8, 3864}, {16, 1}, {24, hashID("alpha")}} {
		if got := binary.LittleEndian.Uint32(b[v.off : v.off+4]); got != v.want {
			t.Errorf("offset %d got %d want %d", v.off, got, v.want)
		}
	}
	if got := math.Float64frombits(binary.LittleEndian.Uint64(b[32:40])); got != 40 {
		t.Errorf("lat=%f", got)
	}
	if got := string(b[64:69]); got != "Alpha" {
		t.Errorf("name=%s", got)
	}
	if b[69] != 0 {
		t.Errorf("not NUL terminated")
	}
	if got := string(b[96:100]); got != "F-18" {
		t.Errorf("aircraft=%s", got)
	}
}

func TestSnapshotNearestFirstAndCapped(t *testing.T) {
	s := newRelay(defaultConfig())
	now := time.Now()
	viewer := &relayClient{ID: "viewer", State: &aircraftState{}}
	for i := 0; i < 40; i++ {
		id := fmt.Sprintf("p%02d", i)
		s.clients[&webSocket{}] = &relayClient{ID: id, Name: id, LastState: now, Joined: now, State: &aircraftState{Lat: float64(i + 1)}}
	}
	b := s.snapshotFor(viewer)
	if got := binary.LittleEndian.Uint32(b[16:20]); got != maxContacts {
		t.Fatalf("contacts=%d", got)
	}
	if got := binary.LittleEndian.Uint32(b[24:28]); got != hashID("p00") {
		t.Errorf("nearest contact not first")
	}
	last := 24 + (maxContacts-1)*contactSize
	if got := binary.LittleEndian.Uint32(b[last : last+4]); got != hashID("p31") {
		t.Errorf("farthest kept contact wrong")
	}
}

func TestPutTextKeepsRunesWhole(t *testing.T) {
	buf := make([]byte, 8)
	putText(buf, "abcdéééé")
	if string(buf[:6]) != "abcdé" || buf[6] != 0 || buf[7] != 0 {
		t.Errorf("got %q", buf)
	}
}

func TestPanelContactID(t *testing.T) {
	if hashID("alpha") != 1569418667 {
		t.Errorf("FNV hash wrong: %d", hashID("alpha"))
	}
	if panelContactID("alpha") != (0x60000000 | (hashID("alpha") & 0x0fffffff)) {
		t.Error("contact id mismatch")
	}
}

func TestExpiredContact(t *testing.T) {
	s := newRelay(defaultConfig())
	viewer := &relayClient{ID: "viewer"}
	contact := &relayClient{ID: "expired", LastState: time.Now().Add(-11 * time.Second), State: &aircraftState{Lat: 1}}
	s.clients[nil] = contact
	b := s.snapshotFor(viewer)
	if got := binary.LittleEndian.Uint32(b[16:20]); got != 0 {
		t.Errorf("expired still visible: %d", got)
	}
}

func TestDashboardRestrictedToLoopback(t *testing.T) {
	s := newRelay(defaultConfig())
	for _, ip := range []string{"198.51.100.55:45000", "192.168.1.30:45000", "10.1.2.3:40000"} {
		req := httptest.NewRequest(http.MethodGet, "/api/stats", nil)
		req.RemoteAddr = ip
		req.Host = "127.0.0.1:8787"
		out := httptest.NewRecorder()
		s.statsHandler(out, req)
		if out.Code != 404 {
			t.Errorf("dashboard allowed remote %s: %d", ip, out.Code)
		}
	}
	req := httptest.NewRequest(http.MethodGet, "/api/stats", nil)
	req.RemoteAddr = "127.0.0.1:1234"
	req.Host = "127.0.0.1:8787"
	out := httptest.NewRecorder()
	s.statsHandler(out, req)
	if out.Code != 200 {
		t.Errorf("dashboard loopback forbidden: %d", out.Code)
	}
}

func TestDashboardRejectsProxiedAndForeignHost(t *testing.T) {
	s := newRelay(defaultConfig())
	cases := []struct {
		name   string
		host   string
		header string
		want   int
	}{
		{"localhost", "localhost:8787", "", 200},
		{"ipv6 loopback", "[::1]:8787", "", 200},
		{"forwarded for", "127.0.0.1:8787", "203.0.113.9", 404},
		{"rebinding host", "evil.example.com:8787", "", 404},
	}
	for _, c := range cases {
		req := httptest.NewRequest(http.MethodGet, "/api/stats", nil)
		req.RemoteAddr = "127.0.0.1:1234"
		req.Host = c.host
		if c.header != "" {
			req.Header.Set("X-Forwarded-For", c.header)
		}
		out := httptest.NewRecorder()
		s.statsHandler(out, req)
		if out.Code != c.want {
			t.Errorf("%s: got %d want %d", c.name, out.Code, c.want)
		}
	}
}

func TestCombatRejectsBadInput(t *testing.T) {
	s := newRelay(defaultConfig())
	c := &relayClient{ID: "sender", Name: "Sender"}
	s.acceptCombat(c, wireMessage{Event: num(3), Weapon: num(2), Target: num(2), WeaponID: num(1), Flags: num(0), Lat: num(120), Lon: num(5), AltFt: num(0), Heading: num(0), Damage: num(0), Duration: num(0), MissDistance: num(0)})
	if s.counts.CombatRejected.Load() != 1 {
		t.Fatal("invalid combat event was accepted")
	}
}

func TestCombatRateLimit(t *testing.T) {
	c := &relayClient{}
	now := time.Now()
	allowed := 0
	for i := 0; i < 1000; i++ {
		if c.allowCombat(now) {
			allowed++
		}
	}
	if allowed != int(combatBurst) {
		t.Errorf("allowed=%d", allowed)
	}
	if !c.allowCombat(now.Add(time.Second)) {
		t.Error("tokens did not refill")
	}
}

func TestLenientNumbers(t *testing.T) {
	var m wireMessage
	if err := json.Unmarshal([]byte(`{"type":"state","lat":"12.5","lon":{"x":1},"altFt":null,"id":42,"event":3.5}`), &m); err != nil {
		t.Fatal(err)
	}
	if !m.Lat.ok || m.Lat.v != 12.5 {
		t.Errorf("numeric string rejected")
	}
	if m.Lon.ok || m.AltFt.ok {
		t.Errorf("bad types accepted")
	}
	if m.ID != "42" {
		t.Errorf("id=%q", m.ID)
	}
	if _, ok := m.Event.unsigned(6); ok {
		t.Errorf("fractional event accepted")
	}
}

func TestConfigFileAndEnv(t *testing.T) {
	path := filepath.Join(t.TempDir(), "relay.ini")
	if err := os.WriteFile(path, []byte("[relay]\nport=9000 ; note\nopen_dashboard=false\npublic_ip_lookup=yes\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := readINI(path)
	if cfg.Port != 9000 || cfg.OpenDashboard || !cfg.PublicIPLookup {
		t.Fatalf("ini: %+v", cfg)
	}
	t.Setenv("PORT", "9100")
	t.Setenv("PUBLIC_IP_LOOKUP", "false")
	t.Setenv("OPEN_DASHBOARD", "true")
	cfg = applyEnv(cfg)
	if cfg.Port != 9100 || !cfg.OpenDashboard || cfg.PublicIPLookup {
		t.Fatalf("env: %+v", cfg)
	}
}

type testClient struct {
	t    *testing.T
	conn net.Conn
	r    *bufio.Reader
}

func startRelay(t *testing.T) (*relayServer, string) {
	t.Helper()
	s := newRelay(config{Port: 8787, OpenDashboard: true})
	ctx, cancel := context.WithCancel(context.Background())
	go s.broadcastLoop(ctx)
	ts := httptest.NewServer(s.routes())
	t.Cleanup(func() {
		cancel()
		ts.Close()
	})
	return s, strings.TrimPrefix(ts.URL, "http://")
}

func dial(t *testing.T, addr string) *testClient {
	t.Helper()
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	fmt.Fprintf(conn, "GET / HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n", addr)
	r := bufio.NewReader(conn)
	resp, err := http.ReadResponse(r, nil)
	if err != nil || resp.StatusCode != 101 {
		t.Fatalf("upgrade failed: %v %v", resp, err)
	}
	return &testClient{t, conn, r}
}

func (c *testClient) send(v any) {
	c.t.Helper()
	payload, _ := json.Marshal(v)
	mask := [4]byte{9, 8, 7, 6}
	frame := []byte{0x81}
	if len(payload) < 126 {
		frame = append(frame, 0x80|byte(len(payload)))
	} else {
		frame = append(frame, 0x80|126, byte(len(payload)>>8), byte(len(payload)))
	}
	frame = append(frame, mask[:]...)
	for i, b := range payload {
		frame = append(frame, b^mask[i&3])
	}
	if _, err := c.conn.Write(frame); err != nil {
		c.t.Fatal(err)
	}
}

func (c *testClient) next(timeout time.Duration) (byte, []byte, error) {
	_ = c.conn.SetReadDeadline(time.Now().Add(timeout))
	var hdr [2]byte
	if _, err := io.ReadFull(c.r, hdr[:]); err != nil {
		return 0, nil, err
	}
	length := int(hdr[1] & 0x7f)
	if length == 126 {
		var x [2]byte
		if _, err := io.ReadFull(c.r, x[:]); err != nil {
			return 0, nil, err
		}
		length = int(binary.BigEndian.Uint16(x[:]))
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(c.r, payload); err != nil {
		return 0, nil, err
	}
	return hdr[0] & 0x0f, payload, nil
}

func (c *testClient) waitText(kind string, timeout time.Duration) (map[string]any, bool) {
	c.t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		op, payload, err := c.next(time.Until(deadline))
		if err != nil {
			return nil, false
		}
		if op != wsText {
			continue
		}
		var m map[string]any
		_ = json.Unmarshal(payload, &m)
		if m["type"] == kind {
			return m, true
		}
	}
	return nil, false
}

func (c *testClient) waitSnapshot(contacts uint32, timeout time.Duration) ([]byte, bool) {
	c.t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		op, payload, err := c.next(time.Until(deadline))
		if err != nil {
			return nil, false
		}
		if op == wsBinary && len(payload) == snapshotSize && binary.LittleEndian.Uint32(payload[16:20]) == contacts {
			return payload, true
		}
	}
	return nil, false
}

func join(t *testing.T, addr, id string) *testClient {
	t.Helper()
	c := dial(t, addr)
	c.send(map[string]any{"type": "hello", "protocol": 3, "id": id, "name": id})
	if _, ok := c.waitText("welcome", 2*time.Second); !ok {
		t.Fatalf("%s: no welcome", id)
	}
	if _, ok := c.waitSnapshot(0, 2*time.Second); !ok {
		t.Fatalf("%s: no snapshot", id)
	}
	return c
}

func stateMsg(lat float64) map[string]any {
	return map[string]any{"type": "state", "lat": lat, "lon": 1, "altFt": 1000, "heading": 90, "speedKts": 200, "aircraft": "F-16"}
}

func combatMsg(event, target uint32) map[string]any {
	return map[string]any{"type": "combat", "event": event, "weapon": 1, "target": target, "weaponId": 7, "flags": 0, "lat": 1, "lon": 1, "altFt": 100, "heading": 10, "damage": 5, "duration": 1, "missDistance": 0}
}

func TestWelcomeComesBeforeSnapshot(t *testing.T) {
	_, addr := startRelay(t)
	c := dial(t, addr)
	c.send(map[string]any{"type": "hello", "protocol": 3, "id": "alpha", "name": "Alpha"})
	op, payload, err := c.next(2 * time.Second)
	if err != nil || op != wsText || !strings.Contains(string(payload), `"welcome"`) {
		t.Fatalf("first frame op=%d payload=%q err=%v", op, payload, err)
	}
}

func TestRejectsOldProtocol(t *testing.T) {
	_, addr := startRelay(t)
	c := dial(t, addr)
	c.send(map[string]any{"type": "hello", "protocol": 1, "id": "alpha"})
	if _, ok := c.waitText("error", 2*time.Second); !ok {
		t.Fatal("no error for protocol 1")
	}
}

func TestStateAndCombatRouting(t *testing.T) {
	s, addr := startRelay(t)
	a := join(t, addr, "alpha")
	b := join(t, addr, "bravo")
	c := join(t, addr, "charlie")

	a.send(stateMsg(10))
	snap, ok := b.waitSnapshot(1, 3*time.Second)
	if !ok || binary.LittleEndian.Uint32(snap[24:28]) != hashID("alpha") {
		t.Fatal("bravo never saw alpha")
	}

	a.send(combatMsg(1, 0))
	for _, p := range []*testClient{b, c} {
		m, ok := p.waitText("combat", 2*time.Second)
		if !ok || m["source"] != float64(panelContactID("alpha")) {
			t.Fatalf("launch not delivered: %v", m)
		}
	}

	a.send(combatMsg(3, panelContactID("bravo")))
	m, ok := b.waitText("combat", 2*time.Second)
	if !ok || m["event"] != float64(3) || uint32(m["flags"].(float64))&1 != 1 {
		t.Fatalf("hit not delivered to target with local flag: %v", m)
	}
	if _, got := c.waitText("combat", 400*time.Millisecond); got {
		t.Fatal("hit leaked to a non target")
	}
	if _, got := a.waitText("combat", 200*time.Millisecond); got {
		t.Fatal("combat echoed to sender")
	}

	delivered := s.counts.CombatDelivered.Load()
	if delivered != 3 {
		t.Errorf("delivered=%d", delivered)
	}
}

func TestBadFieldTypesDoNotDisconnect(t *testing.T) {
	_, addr := startRelay(t)
	a := join(t, addr, "alpha")
	b := join(t, addr, "bravo")
	a.send(map[string]any{"type": "state", "lat": map[string]any{}, "lon": "x"})
	time.Sleep(150 * time.Millisecond)
	a.send(combatMsg(1, 0))
	if _, ok := b.waitText("combat", 2*time.Second); !ok {
		t.Fatal("connection dropped after malformed fields")
	}
}

func TestIdentityReconnectReplacesOld(t *testing.T) {
	s, addr := startRelay(t)
	first := join(t, addr, "alpha")
	join(t, addr, "alpha")
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, _, err := first.next(200 * time.Millisecond); err == io.EOF {
			break
		}
	}
	s.mu.RLock()
	n := len(s.clients)
	s.mu.RUnlock()
	if n != 1 {
		t.Errorf("clients=%d", n)
	}
}

func TestClientIPProxyTrust(t *testing.T) {
	cfg := defaultConfig()
	mk := func(remote, xff, real string) *http.Request {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		r.RemoteAddr = remote
		if xff != "" {
			r.Header.Set("X-Forwarded-For", xff)
		}
		if real != "" {
			r.Header.Set("X-Real-Ip", real)
		}
		return r
	}
	if got := cfg.clientIP(mk("10.0.0.5:1", "203.0.113.7", "")); got != "10.0.0.5" {
		t.Errorf("untrusted mode honoured header: %s", got)
	}
	cfg.TrustProxy = true
	cases := []struct{ remote, xff, real, want string }{
		{"10.0.0.5:1", "203.0.113.7", "", "203.0.113.7"},
		{"10.0.0.5:1", "198.51.100.1, 203.0.113.7, 10.0.0.9", "", "203.0.113.7"},
		{"10.0.0.5:1", "", "203.0.113.8", "203.0.113.8"},
		{"10.0.0.5:1", "garbage", "", "10.0.0.5"},
		{"198.51.100.20:1", "203.0.113.7", "", "198.51.100.20"},
	}
	for _, c := range cases {
		if got := cfg.clientIP(mk(c.remote, c.xff, c.real)); got != c.want {
			t.Errorf("%+v got %s", c, got)
		}
	}
}

func startPeer(t *testing.T, pod string) (*relayServer, string, string) {
	t.Helper()
	cfg := config{Port: 8787, PeerDNS: "x", PeerToken: "secret", PodName: pod}
	s := newRelay(cfg)
	ctx, cancel := context.WithCancel(context.Background())
	go s.broadcastLoop(ctx)
	go s.peerLoop(ctx)
	pub := httptest.NewServer(s.routes())
	peer := httptest.NewServer(s.peerRoutes())
	t.Cleanup(func() {
		cancel()
		pub.Close()
		peer.Close()
	})
	return s, strings.TrimPrefix(pub.URL, "http://"), strings.TrimPrefix(peer.URL, "http://")
}

func TestPeersShareContactsAndCombat(t *testing.T) {
	a, aPub, _ := startPeer(t, "pod-a")
	b, bPub, bPeer := startPeer(t, "pod-b")
	_ = b
	ws, err := dialWS(bPeer, "/peer?pod=pod-a", http.Header{"Authorization": {"Bearer secret"}}, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	_, data, err := ws.readMessage(func() {})
	if err != nil || !strings.Contains(string(data), `"hello"`) {
		t.Fatalf("no hello: %q %v", data, err)
	}
	l := a.addPeer(ws, "pod-b")
	go a.runPeer(l)

	deadline := time.Now().Add(2 * time.Second)
	for a.peerCount() == 0 || b.peerCount() == 0 {
		if time.Now().After(deadline) {
			t.Fatal("peers never linked")
		}
		time.Sleep(20 * time.Millisecond)
	}

	pa := join(t, aPub, "alpha")
	pb := join(t, bPub, "bravo")
	pa.send(stateMsg(10))
	if _, ok := pb.waitSnapshot(1, 3*time.Second); !ok {
		t.Fatal("contact from the other pod never appeared")
	}
	pb.send(stateMsg(11))
	if _, ok := pa.waitSnapshot(1, 3*time.Second); !ok {
		t.Fatal("target from the other pod never appeared")
	}
	pa.send(combatMsg(3, panelContactID("bravo")))
	m, ok := pb.waitText("combat", 2*time.Second)
	if !ok || uint32(m["flags"].(float64))&1 != 1 {
		t.Fatalf("combat not delivered across pods: %v", m)
	}
}

func TestPeerRejectsBadToken(t *testing.T) {
	_, _, peer := startPeer(t, "pod-b")
	if _, err := dialWS(peer, "/peer?pod=pod-a", http.Header{"Authorization": {"Bearer wrong"}}, 2*time.Second); err == nil {
		t.Fatal("bad token accepted")
	}
}

func TestPeerDropPurgesRemoteContacts(t *testing.T) {
	a, aPub, _ := startPeer(t, "pod-a")
	_, _, bPeer := startPeer(t, "pod-b")
	ws, err := dialWS(bPeer, "/peer?pod=pod-a", http.Header{"Authorization": {"Bearer secret"}}, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := ws.readMessage(func() {}); err != nil {
		t.Fatal(err)
	}
	l := a.addPeer(ws, "pod-b")
	go a.runPeer(l)
	pa := join(t, aPub, "alpha")
	_ = pa
	a.mu.Lock()
	a.remote["ghost"] = remoteContact{contact: contact{id: "ghost"}, pod: "pod-b", seen: time.Now()}
	a.mu.Unlock()
	ws.close()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		a.mu.RLock()
		n := len(a.remote)
		a.mu.RUnlock()
		if n == 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("remote contacts survived the peer link")
}

func TestPeerJoinReplacesLocalIdentity(t *testing.T) {
	a, aPub, _ := startPeer(t, "pod-a")
	old := join(t, aPub, "alpha")
	a.handlePeer(&peerLink{pod: "pod-b"}, peerEnvelope{T: "join", ID: "alpha"})
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, _, err := old.next(200 * time.Millisecond); err == io.EOF {
			return
		}
	}
	t.Fatal("old connection was not closed")
}

func benchContacts(n int) []contact {
	now := time.Now()
	out := make([]contact, n)
	for i := range out {
		out[i] = contact{id: fmt.Sprintf("p%04d", i), hash: uint32(i + 1), name: "Pilot", joined: now, state: aircraftState{Lat: float64(i%170) - 85, Lon: float64(i%350) - 175, Aircraft: "F-16"}}
	}
	return out
}

func BenchmarkBroadcast1024(b *testing.B) {
	contacts := benchContacts(1024)
	for i := 0; i < b.N; i++ {
		for v := range contacts {
			buildSnapshot(uint32(i+1), contacts[v].id, 0, &contacts[v].state, contacts)
		}
	}
}

func TestNearestMatchesFullSort(t *testing.T) {
	contacts := benchContacts(300)
	viewer := &contacts[7].state
	got := nearest(contacts[7].id, viewer, contacts)
	if len(got) != maxContacts {
		t.Fatalf("len=%d", len(got))
	}
	for i := 1; i < len(got); i++ {
		if got[i].key < got[i-1].key {
			t.Fatalf("not sorted at %d", i)
		}
	}
	worst := got[len(got)-1].key
	for i := range contacts {
		if i == 7 {
			continue
		}
		k := distanceKey(viewer, &contacts[i].state)
		if k < worst {
			found := false
			for _, g := range got {
				if g.idx == i {
					found = true
				}
			}
			if !found {
				t.Fatalf("closer contact %d missing", i)
			}
		}
	}
}

func TestSnapshotKeepsLatestOnly(t *testing.T) {
	var stats counters
	o := newOutbox(&webSocket{done: make(chan struct{})}, &stats)
	o.enqueueSnapshot([]byte{1})
	o.enqueueSnapshot([]byte{2})
	if p := o.snap.Load(); p == nil || (*p)[0] != 2 {
		t.Fatal("stale snapshot kept")
	}
	if stats.SnapshotsDropped.Load() != 1 {
		t.Errorf("dropped=%d", stats.SnapshotsDropped.Load())
	}
}

func TestPerIPConnectionLimit(t *testing.T) {
	s := newRelay(config{Port: 8787, MaxConnsPerIP: 2})
	if !s.acquireIP("1.2.3.4") || !s.acquireIP("1.2.3.4") {
		t.Fatal("limit hit early")
	}
	if s.acquireIP("1.2.3.4") {
		t.Fatal("limit not enforced")
	}
	if !s.acquireIP("5.6.7.8") {
		t.Fatal("other address blocked")
	}
	s.releaseIP("1.2.3.4")
	if !s.acquireIP("1.2.3.4") {
		t.Fatal("slot not released")
	}
}

func TestReadyAndDraining(t *testing.T) {
	s := newRelay(config{Port: 8787})
	get := func() int {
		out := httptest.NewRecorder()
		s.readyHandler(out, httptest.NewRequest(http.MethodGet, "/ready", nil))
		return out.Code
	}
	if get() != 200 {
		t.Fatal("not ready at start")
	}
	s.draining.Store(true)
	if get() != 503 {
		t.Fatal("ready while draining")
	}
	out := httptest.NewRecorder()
	s.wsHandler(out, httptest.NewRequest(http.MethodGet, "/", nil))
	if out.Code != 503 {
		t.Fatalf("upgrade accepted while draining: %d", out.Code)
	}
	peering := newRelay(config{Port: 8787, PeerDNS: "x", PeerToken: "t"})
	if peering.isReady() {
		t.Fatal("peering pod ready before warmup")
	}
}

func TestSuperviseRestartsAfterPanic(t *testing.T) {
	s := newRelay(config{Port: 8787})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runs := make(chan int, 4)
	n := 0
	s.supervise(ctx, "test", func() {
		n++
		runs <- n
		if n == 1 {
			panic("boom")
		}
	})
	for want := 1; want <= 2; want++ {
		select {
		case got := <-runs:
			if got != want {
				t.Fatalf("run %d", got)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("not restarted")
		}
	}
}

func TestSlowClientIsDisconnectedNotBlocking(t *testing.T) {
	var stats counters
	o := newOutbox(&webSocket{done: make(chan struct{}), conn: nopConn{}}, &stats)
	for i := 0; i < outQueueSize; i++ {
		if !o.enqueue(wsText, []byte("x")) {
			t.Fatal("queue refused early")
		}
	}
	if o.enqueue(wsText, []byte("x")) {
		t.Fatal("overflow accepted")
	}
	if stats.SlowDisconnects.Load() != 1 {
		t.Errorf("slow disconnects=%d", stats.SlowDisconnects.Load())
	}
}

type nopConn struct{ net.Conn }

func (nopConn) Close() error { return nil }

func TestManyClientsAllGetFullSnapshots(t *testing.T) {
	if testing.Short() {
		t.Skip()
	}
	_, addr := startRelay(t)
	const n = 200
	clients := make([]*testClient, n)
	for i := range clients {
		clients[i] = join(t, addr, fmt.Sprintf("pilot%03d", i))
	}
	for i, c := range clients {
		c.send(stateMsg(float64(i%80) - 40))
	}
	start := time.Now()
	for i, c := range clients {
		if _, ok := c.waitSnapshot(maxContacts, 5*time.Second); !ok {
			t.Fatalf("client %d never got a full snapshot", i)
		}
	}
	t.Logf("%d clients saw full snapshots after %v", n, time.Since(start))
}
