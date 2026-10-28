package main

import (
	"encoding/binary"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func floatptr(v float64) *float64 { return &v }
func uintptr(v uint32) *uint32    { return &v }
func TestSnapshotProtocol3(t *testing.T) {
	s := newRelay(config{8787, false, false})
	now := time.Now()
	viewer := &relayClient{ID: "bravo", Name: "Bravo", State: &aircraftState{Lat: 45, Lon: 0}}
	other := &relayClient{ID: "alpha", Name: "Alpha", State: &aircraftState{Lat: 40, Lon: -122, AltFt: 1234, Heading: 90, SpeedKts: 250, Aircraft: "F-18"}, LastState: now}
	s.clients[nil] = other // snapshot assembler consumes client entries only
	b := s.snapshotFor(viewer)
	if len(b) != 3864 {
		t.Fatalf("size=%d", len(b))
	}
	for _, v := range []struct {
		off  int
		want uint32
	}{{0, magic}, {4, 3}, {8, 3864}, {16, 1}, {24, hashID("alpha")}} {
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
		out := httptest.NewRecorder()
		s.statsHandler(out, req)
		if out.Code != 404 {
			t.Errorf("dashboard allowed remote %s: %d", ip, out.Code)
		}
	}
	req := httptest.NewRequest(http.MethodGet, "/api/stats", nil)
	req.RemoteAddr = "127.0.0.1:1234"
	out := httptest.NewRecorder()
	s.statsHandler(out, req)
	if out.Code != 200 {
		t.Errorf("dashboard loopback forbidden: %d", out.Code)
	}
}
func TestCombatRejectsBadInput(t *testing.T) {
	s := newRelay(defaultConfig())
	c := &relayClient{ID: "sender", Name: "Sender"}
	s.acceptCombat(c, wireMessage{Event: uintptr(3), Weapon: uintptr(2), Target: uintptr(2), WeaponID: uintptr(1), Flags: uintptr(0), Lat: floatptr(120), Lon: floatptr(5), AltFt: floatptr(0), Heading: floatptr(0), Damage: floatptr(0), Duration: floatptr(0), MissDistance: floatptr(0)})
	if s.counts.CombatRejected != 1 {
		t.Fatal("invalid combat event was accepted")
	}
}
