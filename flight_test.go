package main

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"
)

func TestTrackIsSampledEveryFiveSeconds(t *testing.T) {
	s := newRelay(defaultConfig())
	now := time.Now()
	c := &relayClient{ID: "a", Name: "Alpha", Joined: now, State: &aircraftState{Lat: 1, Lon: 2, AltFt: 3000}}
	s.mu.Lock()
	c.sampleTrackLocked(now)
	c.sampleTrackLocked(now.Add(2 * time.Second))
	c.sampleTrackLocked(now.Add(5 * time.Second))
	c.sampleTrackLocked(now.Add(9 * time.Second))
	c.sampleTrackLocked(now.Add(11 * time.Second))
	s.mu.Unlock()
	if len(c.Track) != 3 {
		t.Fatalf("expected 3 points, got %d: %+v", len(c.Track), c.Track)
	}
}

func TestLongTracksAreThinnedNotCut(t *testing.T) {
	s := newRelay(defaultConfig())
	now := time.Now()
	c := &relayClient{ID: "a", Name: "Alpha", Joined: now, State: &aircraftState{Lat: 1, Lon: 2}}
	s.mu.Lock()
	for i := 0; i < trackMaxPoints*3; i++ {
		c.sampleTrackLocked(now.Add(time.Duration(i) * 20 * time.Second))
	}
	s.mu.Unlock()
	if len(c.Track) >= trackMaxPoints || len(c.Track) < trackMaxPoints/3 {
		t.Fatalf("track should stay under the cap but keep its shape, got %d points", len(c.Track))
	}
}

func TestGunAndFlareBurstsAreThrottled(t *testing.T) {
	now := time.Now()
	c := &relayClient{Joined: now}
	for i := 0; i < 50; i++ {
		c.addEventLocked(now.Add(time.Duration(i)*100*time.Millisecond), "guns", "TRACER", 1, 1, 1000, "")
		c.addEventLocked(now.Add(time.Duration(i)*100*time.Millisecond), "countermeasure", "FLARE", 1, 1, 1000, "")
	}
	guns, flares := 0, 0
	for _, e := range c.Events {
		switch e.Kind {
		case "guns":
			guns++
		case "countermeasure":
			flares++
		}
	}
	if guns != 2 || flares != 1 {
		t.Fatalf("5 seconds of fire should leave 2 gun markers (3 second gap) and 1 flare marker (6 second gap), got %d and %d", guns, flares)
	}
}

func TestFlightPathWeaponsAndHitsAreRecordedAndServed(t *testing.T) {
	cfg := config{Port: 8787, OpenDashboard: true, LogLevel: 1, PublicAPI: true}
	s, addr := startRelayWith(t, cfg)
	a, _ := joinNamed(t, addr, "alpha", "Alpha")
	b, _ := joinNamed(t, addr, "bravo", "Bravo")
	a.send(teamState(10, 10, 0, 0, 1))
	time.Sleep(120 * time.Millisecond)
	b.send(teamState(10.1, 10, 0, 0, 1))
	time.Sleep(300 * time.Millisecond)

	a.send(combatMsg(1, panelContactID("bravo")))
	if _, ok := b.waitText("combat", 2*time.Second); !ok {
		t.Fatal("launch never arrived")
	}
	a.send(combatMsg(3, panelContactID("bravo")))
	if _, ok := b.waitText("combat", 2*time.Second); !ok {
		t.Fatal("hit never arrived")
	}

	s.mu.Lock()
	for _, c := range s.clients {
		c.Joined = c.Joined.Add(-time.Minute)
	}
	s.mu.Unlock()
	_ = a.conn.Close()
	_ = b.conn.Close()
	deadline := time.Now().Add(3 * time.Second)
	for len(s.historySnapshot()) < 2 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	var alpha, bravo sessionRecord
	for _, r := range s.historySnapshot() {
		switch r.Name {
		case "Alpha":
			alpha = r
		case "Bravo":
			bravo = r
		}
	}
	if len(alpha.Track) == 0 || len(bravo.Track) == 0 {
		t.Fatalf("both flights should have a path: %d and %d points", len(alpha.Track), len(bravo.Track))
	}
	kinds := map[string]flightEvent{}
	for _, e := range alpha.Events {
		kinds[e.Kind] = e
	}
	if kinds["launch"].Weapon != "AIM120" {
		t.Errorf("alpha's launch missing or wrong: %+v", alpha.Events)
	}
	if kinds["hit"].With != "Bravo" {
		t.Errorf("alpha's successful hit should name its victim: %+v", alpha.Events)
	}
	if len(bravo.Events) == 0 || bravo.Events[len(bravo.Events)-1].Kind != "hitTaken" || bravo.Events[len(bravo.Events)-1].With != "Alpha" {
		t.Errorf("bravo should record the hit it took and who fired it: %+v", bravo.Events)
	}

	req := httptest.NewRequest("GET", "/api/public/flight/"+sessionID(alpha.Name, alpha.Started), nil)
	rec := httptest.NewRecorder()
	s.publicFlightHandler(rec, req)
	if rec.Code != 200 {
		t.Fatalf("flight endpoint status %d", rec.Code)
	}
	var got publicFlightDetail
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Name != "Alpha" || len(got.Track) == 0 || len(got.Events) < 2 || got.Track[0][1] != 10 {
		t.Errorf("flight detail looks wrong: %+v", got)
	}
	missing := httptest.NewRecorder()
	s.publicFlightHandler(missing, httptest.NewRequest("GET", "/api/public/flight/nope", nil))
	if missing.Code != 404 {
		t.Errorf("an unknown flight should be a 404, got %d", missing.Code)
	}
}
