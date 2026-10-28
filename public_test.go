package main

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"
)

func TestPublicAPIOffByDefault(t *testing.T) {
	s := newRelay(defaultConfig())
	rec := httptest.NewRecorder()
	s.publicHandler(rec, httptest.NewRequest("GET", "/api/public", nil))
	if rec.Code != 404 {
		t.Fatalf("status %d", rec.Code)
	}
}

func TestPublicAPIListsLiveLocalAndRemotePilots(t *testing.T) {
	cfg := defaultConfig()
	cfg.PublicAPI = true
	s := newRelay(cfg)
	now := time.Now()
	s.clients[nil] = &relayClient{ID: "a", Name: "Alpha", Joined: now.Add(-90 * time.Second), LastState: now, State: &aircraftState{Lat: 47.44963, Lon: -122.31188, AltFt: 1234, Heading: 91.4, SpeedKts: 120.6, Aircraft: "C172"}}
	s.clients[&webSocket{}] = &relayClient{ID: "stale", Name: "Stale", LastState: now.Add(-time.Minute), State: &aircraftState{}}
	s.remote["b"] = remoteContact{contact: contact{id: "b", name: "Bravo", joined: now.Add(-10 * time.Second), state: aircraftState{Lat: 1, Lon: 2, Aircraft: "A320"}}, pod: "p2", seen: now}

	rec := httptest.NewRecorder()
	s.publicHandler(rec, httptest.NewRequest("GET", "/api/public", nil))
	if rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	var got publicInfo
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Online != 2 || len(got.Pilots) != 2 {
		t.Fatalf("pilots %+v", got.Pilots)
	}
	a := got.Pilots[0]
	if a.Name != "Alpha" || a.Lat != 47.45 || a.Lon != -122.31 || a.AltFt != 1200 || a.Heading != 91 || a.SpeedKts != 121 {
		t.Errorf("not rounded as expected: %+v", a)
	}
	if got.Pilots[1].Name != "Bravo" {
		t.Errorf("order %+v", got.Pilots)
	}
}
