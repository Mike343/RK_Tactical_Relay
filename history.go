package main

import (
	"math"
	"sort"
	"time"
)

const (
	historyLimit  = 200
	historyMinAge = 20 * time.Second
)

type sessionRecord struct {
	Name        string  `json:"name"`
	Aircraft    string  `json:"aircraft"`
	Started     int64   `json:"started"`
	Seconds     int64   `json:"seconds"`
	MaxAltFt    float64 `json:"maxAltFt"`
	MaxSpeedKts float64 `json:"maxSpeedKts"`
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
		if r.Name == "" || r.Started <= 0 || r.Seconds < 0 {
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

func (s *relayServer) finishSession(c *relayClient, now time.Time) {
	s.mu.RLock()
	age := now.Sub(c.Joined)
	hasFlown := c.State != nil
	rec := sessionRecord{Name: c.Name, Started: c.Joined.UnixNano(), Seconds: int64(age.Seconds()), MaxAltFt: c.MaxAltFt, MaxSpeedKts: c.MaxSpeedKts}
	if c.State != nil {
		rec.Aircraft = c.State.Aircraft
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
		Name: r.Name, Aircraft: r.Aircraft,
		Started:  time.Unix(0, r.Started).UTC().Format(time.RFC3339),
		Seconds:  r.Seconds,
		MaxAltFt: int(math.Round(r.MaxAltFt/100) * 100), MaxSpeedKts: int(math.Round(r.MaxSpeedKts)),
	}
}
