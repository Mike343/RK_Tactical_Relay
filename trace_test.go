package main

import (
	"strings"
	"testing"
	"time"
)

func logged(s *relayServer, prefix string) []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []string
	for _, line := range s.logLines {
		if strings.Contains(line, prefix) {
			out = append(out, line)
		}
	}
	return out
}

func waitLog(t *testing.T, s *relayServer, prefix string) string {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if lines := logged(s, prefix); len(lines) > 0 {
			return lines[len(lines)-1]
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("no log line containing %q", prefix)
	return ""
}

func TestOpenRulesShowEveryoneAndAllowCrossTeamCombat(t *testing.T) {
	_, addr := startRelayWith(t, config{Port: 8787, OpenDashboard: true, LogLevel: 1})
	a := join(t, addr, "alpha")
	b := join(t, addr, "bravo")
	c := join(t, addr, "charlie")

	a.send(teamState(0, 0, 0, 1, 1))
	time.Sleep(120 * time.Millisecond)
	b.send(teamState(5, 5, 0, 2, 1))
	time.Sleep(120 * time.Millisecond)
	c.send(teamState(40, 40, 0, 0, 1))
	time.Sleep(300 * time.Millisecond)

	snap, ok := a.waitSnapshot(2, 3*time.Second)
	if !ok {
		t.Fatal("alpha never saw both other pilots")
	}
	for i := 0; i < 2; i++ {
		o := 24 + i*contactSize
		if snap[o+4]&flagTracked == 0 {
			t.Errorf("contact %d should be tracked in open mode, flags=%d", i, snap[o+4])
		}
	}

	a.send(combatMsg(1, panelContactID("charlie")))
	if _, got := c.waitText("combat", 2*time.Second); !got {
		t.Fatal("a team pilot should be able to engage a solo pilot in open mode")
	}
	a.send(combatMsg(1, panelContactID("bravo")))
	if _, got := b.waitText("combat", 2*time.Second); !got {
		t.Fatal("teams should be able to fight each other")
	}
}

func TestTraceLogsExplainWhoSeesWhom(t *testing.T) {
	s, addr := startRelay(t)
	a, _ := joinNamed(t, addr, "alpha", "Alpha")
	b, _ := joinNamed(t, addr, "bravo", "Bravo")
	a.send(teamState(0, 0, 0, 1, 7))
	time.Sleep(120 * time.Millisecond)
	b.send(teamState(0.1, 0, 0, 2, 7))

	first := waitLog(t, s, "STATE_FIRST name=\"Alpha\"")
	if !strings.Contains(first, "team=1") || !strings.Contains(first, "flight=7") {
		t.Errorf("first state line lacks the team and flight: %s", first)
	}
	view := waitLog(t, s, "VIEW viewer=\"Alpha\" team=1 contacts=1")
	if !strings.Contains(view, "Bravo(t2,tracked)") {
		t.Errorf("view line should name the contact and its tracking: %s", view)
	}
	connect := waitLog(t, s, "CONNECT name=\"Alpha\"")
	if !strings.Contains(connect, "proto=3") {
		t.Errorf("connect line should record the protocol: %s", connect)
	}
}

func TestStateDropsAreLogged(t *testing.T) {
	s, addr := startRelay(t)
	a, _ := joinNamed(t, addr, "alpha", "Alpha")
	bad := teamState(0, 0, 0, 1, 1)
	bad["altFt"] = 999999
	a.send(bad)
	line := waitLog(t, s, "STATE_DROP name=\"Alpha\"")
	if !strings.Contains(line, "out_of_range") {
		t.Errorf("drop line should say why: %s", line)
	}
}

func TestStaleAndMissingStateAreReported(t *testing.T) {
	s := newRelay(config{LogLevel: 1})
	now := time.Now()
	quiet := &relayClient{ID: "q", Name: "Quiet", Joined: now.Add(-time.Minute)}
	stale := &relayClient{ID: "s", Name: "Stale", Joined: now.Add(-time.Minute), State: &aircraftState{}, LastState: now.Add(-9 * time.Second)}
	views := []heartbeatView{
		{c: quiet, connected: time.Minute},
		{c: stale, hasState: true, stateAge: 9 * time.Second, connected: time.Minute},
	}
	s.traceHeartbeat(views, roomLogEvery)
	if lines := logged(s, "NO_STATE name=\"Quiet\""); len(lines) != 1 {
		t.Errorf("a pilot that never sent a position should be reported once: %v", lines)
	}
	if lines := logged(s, "STATE_STALE name=\"Stale\""); len(lines) != 1 {
		t.Errorf("a pilot whose position stopped should be reported once: %v", lines)
	}
	s.traceHeartbeat(views, roomLogEvery+1)
	if lines := logged(s, "STATE_STALE"); len(lines) != 1 {
		t.Errorf("a stale pilot must not be reported again every heartbeat: %v", lines)
	}
	if lines := logged(s, "ROOM users=2"); len(lines) != 1 {
		t.Errorf("expected one room summary: %v", lines)
	}
}
