package main

import (
	"strings"
	"testing"
	"time"
)

func joinNamed(t *testing.T, addr, id, name string) (*testClient, string) {
	t.Helper()
	c := dial(t, addr)
	c.send(map[string]any{"type": "hello", "protocol": 3, "id": id, "name": name})
	m, ok := c.waitText("welcome", 2*time.Second)
	if !ok {
		t.Fatalf("%s: no welcome", id)
	}
	got, _ := m["name"].(string)
	return c, got
}

func TestDuplicateNamesGetANumber(t *testing.T) {
	_, addr := startRelay(t)
	_, first := joinNamed(t, addr, "pilot-a", "Maverick")
	_, second := joinNamed(t, addr, "pilot-b", "Maverick")
	_, third := joinNamed(t, addr, "pilot-c", "maverick")
	_, other := joinNamed(t, addr, "pilot-d", "Goose")
	if first != "Maverick" {
		t.Errorf("first pilot should keep the name, got %q", first)
	}
	if second != "Maverick 2" {
		t.Errorf("second pilot got %q", second)
	}
	if third != "maverick 3" {
		t.Errorf("third pilot got %q", third)
	}
	if other != "Goose" {
		t.Errorf("a different name should not change, got %q", other)
	}
}

func TestReconnectKeepsTheName(t *testing.T) {
	_, addr := startRelay(t)
	_, first := joinNamed(t, addr, "pilot-a", "Maverick")
	_, again := joinNamed(t, addr, "pilot-a", "Maverick")
	if first != "Maverick" || again != "Maverick" {
		t.Errorf("same pilot reconnecting got %q then %q", first, again)
	}
}

func TestNameIsFreedWhenThePilotLeaves(t *testing.T) {
	s, addr := startRelay(t)
	a, _ := joinNamed(t, addr, "pilot-a", "Maverick")
	a.conn.Close()
	deadline := time.Now().Add(2 * time.Second)
	for {
		s.mu.RLock()
		n := len(s.clients)
		s.mu.RUnlock()
		if n == 0 || time.Now().After(deadline) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	_, next := joinNamed(t, addr, "pilot-b", "Maverick")
	if next != "Maverick" {
		t.Errorf("name should be free again, got %q", next)
	}
}

func TestLongNamesStayUniqueAfterTruncation(t *testing.T) {
	s := newRelay(defaultConfig())
	long := strings.Repeat("x", 40)
	first := s.uniqueNameLocked(long, "a", time.Now())
	s.clients[nil] = &relayClient{ID: "a", Name: first}
	second := s.uniqueNameLocked(long, "b", time.Now())
	if len(first) > maxNameBytes || len(second) > maxNameBytes {
		t.Fatalf("names must fit the snapshot field: %q %q", first, second)
	}
	if nameKey(first) == nameKey(second) || !strings.HasSuffix(second, " 2") {
		t.Errorf("long duplicate names collided: %q %q", first, second)
	}
}

func TestRemoteNamesAreTaken(t *testing.T) {
	s := newRelay(defaultConfig())
	s.remote["far"] = remoteContact{contact: contact{id: "far", name: "Iceman"}, pod: "p2", seen: time.Now()}
	if got := s.uniqueNameLocked("Iceman", "new", time.Now()); got != "Iceman 2" {
		t.Errorf("a pilot on another replica should reserve the name, got %q", got)
	}
}
