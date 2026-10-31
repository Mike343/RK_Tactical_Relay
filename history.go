package main

import (
	"fmt"
	"hash/fnv"
	"math"
	"sort"
	"time"
)

const (
	historyLimit   = 200
	historyMinAge  = 20 * time.Second
	trackStep      = 5 * time.Second
	trackMaxPoints = 900
	eventsMax      = 300
	gunGap         = 3 * time.Second
	flareGap       = 6 * time.Second
	historyChunk   = 12
)

type trackPoint struct {
	T     int     `json:"t"`
	Lat   float64 `json:"a"`
	Lon   float64 `json:"o"`
	AltFt int     `json:"h"`
}

type flightEvent struct {
	T      int     `json:"t"`
	Kind   string  `json:"k"`
	Weapon string  `json:"w,omitempty"`
	Lat    float64 `json:"a"`
	Lon    float64 `json:"o"`
	AltFt  int     `json:"h"`
	With   string  `json:"with,omitempty"`
}

type sessionRecord struct {
	Name        string        `json:"name"`
	Aircraft    string        `json:"aircraft"`
	Started     int64         `json:"started"`
	Seconds     int64         `json:"seconds"`
	MaxAltFt    float64       `json:"maxAltFt"`
	MaxSpeedKts float64       `json:"maxSpeedKts"`
	Track       []trackPoint  `json:"track,omitempty"`
	Events      []flightEvent `json:"events,omitempty"`
}

func sessionID(name string, started int64) string {
	h := fnv.New64a()
	_, _ = fmt.Fprintf(h, "%s|%d", name, started)
	return fmt.Sprintf("%x", h.Sum64())
}

func (s *relayServer) recordSession(r sessionRecord) {
	s.histMu.Lock()
	defer s.histMu.Unlock()
	for _, h := range s.history {
		if h.Started == r.Started && h.Name == r.Name {
			return
		}
	}
	s.history = append(s.history, r)
	sort.Slice(s.history, func(i, j int) bool { return s.history[i].Started < s.history[j].Started })
	if len(s.history) > historyLimit {
		s.history = append([]sessionRecord(nil), s.history[len(s.history)-historyLimit:]...)
	}
}

func (s *relayServer) mergeHistory(records []sessionRecord) {
	for _, r := range records {
		if r.Name == "" || r.Started <= 0 || r.Seconds < 0 || len(r.Track) > trackMaxPoints*2 || len(r.Events) > eventsMax*2 {
			continue
		}
		s.recordSession(r)
	}
}

func (s *relayServer) historySnapshot() []sessionRecord {
	s.histMu.Lock()
	defer s.histMu.Unlock()
	return append([]sessionRecord(nil), s.history...)
}

func (s *relayServer) findSession(id string) (sessionRecord, bool) {
	s.histMu.Lock()
	defer s.histMu.Unlock()
	for _, h := range s.history {
		if sessionID(h.Name, h.Started) == id {
			return h, true
		}
	}
	return sessionRecord{}, false
}

func (c *relayClient) sampleTrackLocked(now time.Time) {
	step := c.trackEvery
	if step == 0 {
		step = trackStep
	}
	if c.State == nil || (len(c.Track) > 0 && now.Sub(c.lastTrack) < step) {
		return
	}
	c.lastTrack = now
	c.Track = append(c.Track, trackPoint{T: int(now.Sub(c.Joined).Seconds()), Lat: c.State.Lat, Lon: c.State.Lon, AltFt: int(c.State.AltFt)})
	if len(c.Track) >= trackMaxPoints {
		thinned := make([]trackPoint, 0, len(c.Track)/2+1)
		for i := 0; i < len(c.Track); i += 2 {
			thinned = append(thinned, c.Track[i])
		}
		c.Track = thinned
		c.trackEvery = step * 2
	}
}

func (c *relayClient) addEventLocked(now time.Time, kind, weapon string, lat, lon, altFt float64, with string) {
	if len(c.Events) >= eventsMax {
		return
	}
	switch kind {
	case "guns":
		if now.Sub(c.lastGun) < gunGap {
			return
		}
		c.lastGun = now
	case "countermeasure":
		if now.Sub(c.lastFlare) < flareGap {
			return
		}
		c.lastFlare = now
	}
	c.Events = append(c.Events, flightEvent{T: int(now.Sub(c.Joined).Seconds()), Kind: kind, Weapon: weapon, Lat: lat, Lon: lon, AltFt: int(altFt), With: with})
}

func (s *relayServer) recordCombatEvent(c *relayClient, base combatMessage, victim string) {
	var kind string
	switch base.Event {
	case 1:
		kind = "launch"
		if base.Weapon == 3 {
			kind = "guns"
		}
	case 3:
		kind = "hit"
	case 4:
		kind = "countermeasure"
	default:
		return
	}
	s.mu.Lock()
	c.addEventLocked(time.Now(), kind, weaponName(base.Weapon), base.Lat, base.Lon, base.AltFt, victim)
	s.mu.Unlock()
}

func (s *relayServer) recordHitTaken(dest *relayClient, base combatMessage, attacker string) {
	s.mu.Lock()
	dest.addEventLocked(time.Now(), "hitTaken", weaponName(base.Weapon), base.Lat, base.Lon, base.AltFt, attacker)
	s.mu.Unlock()
}

func (s *relayServer) nameForPanel(id uint32) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, c := range s.clients {
		if c.Source == id {
			return c.Name
		}
	}
	for _, rc := range s.remote {
		if rc.panel == id {
			return rc.name
		}
	}
	return ""
}

func (s *relayServer) finishSession(c *relayClient, now time.Time) {
	s.mu.RLock()
	age := now.Sub(c.Joined)
	hasFlown := c.State != nil
	rec := sessionRecord{Name: c.Name, Started: c.Joined.UnixNano(), Seconds: int64(age.Seconds()), MaxAltFt: c.MaxAltFt, MaxSpeedKts: c.MaxSpeedKts}
	if c.State != nil {
		rec.Aircraft = c.State.Aircraft
		rec.Track = append([]trackPoint(nil), c.Track...)
		rec.Events = append([]flightEvent(nil), c.Events...)
	}
	s.mu.RUnlock()
	if !hasFlown || age < historyMinAge {
		return
	}
	s.recordSession(rec)
	s.broadcastPeers(peerEnvelope{T: "session", Session: &rec})
}

func roundedSession(r sessionRecord) publicSession {
	return publicSession{
		ID:   sessionID(r.Name, r.Started),
		Name: r.Name, Aircraft: r.Aircraft,
		Started:  time.Unix(0, r.Started).UTC().Format(time.RFC3339),
		Seconds:  r.Seconds,
		MaxAltFt: int(math.Round(r.MaxAltFt/100) * 100), MaxSpeedKts: int(math.Round(r.MaxSpeedKts)),
		HasPath: len(r.Track) > 1,
	}
}

func rounded(v float64) float64 { return math.Round(v*100) / 100 }

func publicFlight(r sessionRecord) publicFlightDetail {
	out := publicFlightDetail{publicSession: roundedSession(r)}
	out.Track = make([][4]float64, 0, len(r.Track))
	for _, p := range r.Track {
		out.Track = append(out.Track, [4]float64{float64(p.T), rounded(p.Lat), rounded(p.Lon), math.Round(float64(p.AltFt)/100) * 100})
	}
	out.Events = make([]publicFlightEvent, 0, len(r.Events))
	for _, e := range r.Events {
		out.Events = append(out.Events, publicFlightEvent{T: e.T, Kind: e.Kind, Weapon: e.Weapon, Lat: rounded(e.Lat), Lon: rounded(e.Lon), AltFt: int(math.Round(float64(e.AltFt)/100) * 100), With: e.With})
	}
	return out
}
