package main

import (
	"encoding/binary"
	"testing"
	"time"
)

func teamState(lat, lon, heading float64, team, flight int, detected ...uint32) map[string]any {
	return map[string]any{"type": "state", "lat": lat, "lon": lon, "altFt": 1000, "heading": heading, "speedKts": 200, "aircraft": "F-16", "team": team, "flight": flight, "detected": detected}
}

func TestSnapshotVersionAndTeamFlags(t *testing.T) {
	ally := contact{id: "ally", team: 1, panel: panelContactID("ally"), state: aircraftState{Lat: 0, Lon: 0, Heading: 0}}
	foe := contact{id: "foe", hash: 5, team: 2, panel: panelContactID("foe"), state: aircraftState{Lat: 0.1, Lon: 0}}
	far := contact{id: "far", hash: 6, team: 2, panel: panelContactID("far"), state: aircraftState{Lat: 40, Lon: 90}}
	contacts := []contact{ally, foe, far}
	b := buildSnapshot(1, "ally", 1, &ally.state, contacts)
	if got := binary.LittleEndian.Uint32(b[4:8]); got != 4 {
		t.Fatalf("snapshot version %d", got)
	}
	flags := map[uint32]uint32{}
	for i := 0; i < int(binary.LittleEndian.Uint32(b[16:20])); i++ {
		o := 24 + i*contactSize
		flags[binary.LittleEndian.Uint32(b[o:o+4])] = binary.LittleEndian.Uint32(b[o+4 : o+8])
	}
	if flags[5] != 2|flagTracked {
		t.Errorf("foe in the cone should be tracked, flags=%d", flags[5])
	}
	if flags[6] != 2 {
		t.Errorf("distant foe should not be tracked, flags=%d", flags[6])
	}
	solo := buildSnapshot(2, "x", 0, nil, contacts)
	if got := binary.LittleEndian.Uint32(solo[28:32]); got&flagTracked == 0 {
		t.Errorf("solo viewers track everyone, flags=%d", got)
	}
}

func TestDetectedListTracksTarget(t *testing.T) {
	ally := contact{id: "ally", team: 1, detected: []uint32{panelContactID("far")}, state: aircraftState{Heading: 180}}
	far := contact{id: "far", hash: 6, team: 2, panel: panelContactID("far"), state: aircraftState{Lat: 40, Lon: 90}}
	b := buildSnapshot(1, "ally", 1, &ally.state, []contact{ally, far})
	if got := binary.LittleEndian.Uint32(b[28:32]); got != 2|flagTracked {
		t.Errorf("flags=%d", got)
	}
}

func TestTeamsInteract(t *testing.T) {
	for _, c := range []struct {
		a, b, weapon uint32
		want         bool
	}{
		{0, 0, 1, true}, {0, 1, 1, false}, {1, 0, 1, false}, {1, 2, 1, true}, {1, 1, 1, false}, {1, 1, 3, true},
	} {
		if got := teamsInteract(c.a, c.b, c.weapon); got != c.want {
			t.Errorf("%v: got %v", c, got)
		}
	}
}

func TestHelloAcceptsProtocolFour(t *testing.T) {
	_, addr := startRelay(t)
	c := dial(t, addr)
	c.send(map[string]any{"type": "hello", "protocol": 4, "id": "four", "name": "Four"})
	m, ok := c.waitText("welcome", 2*time.Second)
	if !ok || m["protocol"] != float64(4) {
		t.Fatalf("welcome %v", m)
	}
}

func TestTeamCombatRules(t *testing.T) {
	_, addr := startRelay(t)
	a := join(t, addr, "alpha")
	b := join(t, addr, "bravo")
	c := join(t, addr, "charlie")

	a.send(teamState(0, 0, 0, 1, 1))
	time.Sleep(120 * time.Millisecond)
	b.send(teamState(0.1, 0, 0, 2, 1))
	time.Sleep(120 * time.Millisecond)
	c.send(teamState(0.2, 0, 0, 0, 1))
	time.Sleep(300 * time.Millisecond)

	a.send(combatMsg(1, panelContactID("charlie")))
	if _, got := c.waitText("combat", 400*time.Millisecond); got {
		t.Fatal("team pilot reached a solo pilot")
	}

	a.send(combatMsg(1, panelContactID("bravo")))
	m, ok := b.waitText("combat", 2*time.Second)
	if !ok || uint32(m["flags"].(float64))>>4&3 != 1 {
		t.Fatalf("launch at a tracked enemy should arrive stamped with the team: %v", m)
	}

	a.send(combatMsg(1, panelContactID("nobody")))
	if _, got := b.waitText("combat", 300*time.Millisecond); got {
		t.Fatal("launch at an unknown target was delivered")
	}

	for _, got := c.waitText("combat", 200*time.Millisecond); got; _, got = c.waitText("combat", 200*time.Millisecond) {
	}
	cm := combatMsg(4, 0)
	a.send(cm)
	if _, got := c.waitText("combat", 300*time.Millisecond); got {
		t.Fatal("countermeasures crossed between a team and a solo pilot")
	}
	if _, got := b.waitText("combat", 2*time.Second); !got {
		t.Fatal("countermeasures should reach other team pilots")
	}
}

func TestSessionHistory(t *testing.T) {
	s := newRelay(defaultConfig())
	now := time.Now()
	long := &relayClient{ID: "a", Name: "Alpha", Joined: now.Add(-90 * time.Second), State: &aircraftState{Aircraft: "C172"}, MaxAltFt: 4520, MaxSpeedKts: 118.4}
	s.finishSession(long, now)
	s.finishSession(&relayClient{ID: "b", Name: "Short", Joined: now.Add(-5 * time.Second), State: &aircraftState{}}, now)
	s.finishSession(&relayClient{ID: "c", Name: "NeverFlew", Joined: now.Add(-90 * time.Second)}, now)
	h := s.historySnapshot()
	if len(h) != 1 || h[0].Name != "Alpha" || h[0].Aircraft != "C172" || h[0].Seconds != 90 {
		t.Fatalf("history %+v", h)
	}
	s.mergeHistory(h)
	s.mergeHistory([]sessionRecord{{Name: "Remote", Started: now.UnixNano(), Seconds: 300}})
	if got := len(s.historySnapshot()); got != 2 {
		t.Fatalf("merge should dedupe and add, got %d", got)
	}
	info := s.publicInfo(now)
	if len(info.Recent) != 2 || info.Recent[0].Name != "Remote" || info.Recent[1].MaxAltFt != 4500 {
		t.Fatalf("recent %+v", info.Recent)
	}
}
