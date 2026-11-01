package main

import (
	"encoding/json"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

type publicPilot struct {
	Name     string  `json:"name"`
	Aircraft string  `json:"aircraft"`
	Lat      float64 `json:"lat"`
	Lon      float64 `json:"lon"`
	AltFt    int     `json:"alt_ft"`
	Heading  int     `json:"heading"`
	SpeedKts int     `json:"speed_kts"`
	Online   int64   `json:"online_seconds"`
}

type publicFlightEvent struct {
	T      int     `json:"t"`
	Kind   string  `json:"kind"`
	Weapon string  `json:"weapon,omitempty"`
	Lat    float64 `json:"lat"`
	Lon    float64 `json:"lon"`
	AltFt  int     `json:"alt_ft"`
	With   string  `json:"with,omitempty"`
}

type publicFlightDetail struct {
	publicSession
	Track  [][4]float64        `json:"track"`
	Events []publicFlightEvent `json:"events"`
}

type publicSession struct {
	ID          string `json:"id"`
	HasPath     bool   `json:"has_path"`
	Name        string `json:"name"`
	Aircraft    string `json:"aircraft"`
	Started     string `json:"started"`
	Seconds     int64  `json:"seconds"`
	MaxAltFt    int    `json:"max_alt_ft"`
	MaxSpeedKts int    `json:"max_speed_kts"`
}

type publicInfo struct {
	Version  string        `json:"version"`
	Network  string        `json:"network"`
	Protocol uint32        `json:"protocol"`
	Online   int           `json:"online"`
	Replicas int           `json:"replicas"`
	Uptime   int64         `json:"uptime_seconds"`
	Pilots   []publicPilot `json:"pilots"`
}

func roundTo(v float64, places int) float64 {
	p := math.Pow(10, float64(places))
	return math.Round(v*p) / p
}

func (s *relayServer) publicInfo(now time.Time) publicInfo {
	s.mu.RLock()
	out := publicInfo{
		Version: versionLabel, Network: globalNetwork, Protocol: protocol,
		Replicas: len(s.peers) + 1, Uptime: int64(now.Sub(s.started).Seconds()),
		Pilots: make([]publicPilot, 0, len(s.clients)+len(s.remote)),
	}
	add := func(name string, st aircraftState, joined time.Time) {
		out.Pilots = append(out.Pilots, publicPilot{
			Name: name, Aircraft: st.Aircraft,
			Lat: roundTo(st.Lat, 2), Lon: roundTo(st.Lon, 2),
			AltFt: int(math.Round(st.AltFt/100) * 100), Heading: int(math.Round(st.Heading)), SpeedKts: int(math.Round(st.SpeedKts)),
			Online: max(0, int64(now.Sub(joined).Seconds())),
		})
	}
	for _, c := range s.clients {
		if c.State != nil && now.Sub(c.LastState) <= stateExpiry {
			add(c.Name, *c.State, c.Joined)
		}
	}
	for _, rc := range s.remote {
		if now.Sub(rc.seen) <= stateExpiry {
			add(rc.name, rc.state, rc.joined)
		}
	}
	s.mu.RUnlock()
	sort.Slice(out.Pilots, func(i, j int) bool {
		if out.Pilots[i].Online != out.Pilots[j].Online {
			return out.Pilots[i].Online > out.Pilots[j].Online
		}
		return out.Pilots[i].Name < out.Pilots[j].Name
	})
	if len(out.Pilots) > maxPlayers {
		out.Pilots = out.Pilots[:maxPlayers]
	}
	out.Online = len(out.Pilots)
	return out
}

func (s *relayServer) publicHandler(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.PublicAPI || (r.Method != http.MethodGet && r.Method != http.MethodHead) {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=2")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_ = json.NewEncoder(w).Encode(s.publicInfo(time.Now()))
}

func (s *relayServer) publicFlightHandler(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.PublicAPI || (r.Method != http.MethodGet && r.Method != http.MethodHead) {
		http.NotFound(w, r)
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/public/flight/")
	rec, ok := s.findSession(id)
	if id == "" || !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=30")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_ = json.NewEncoder(w).Encode(publicFlight(rec))
}

const (
	flightsPageSize    = 10
	flightsMaxPageSize = 50
)

type publicFlightPage struct {
	Page    int             `json:"page"`
	Pages   int             `json:"pages"`
	Size    int             `json:"size"`
	Total   int             `json:"total"`
	Flights []publicSession `json:"flights"`
}

func (s *relayServer) recentFlights(page, size int) publicFlightPage {
	s.histMu.Lock()
	defer s.histMu.Unlock()
	total := len(s.history)
	pages := max(1, (total+size-1)/size)
	page = min(max(page, 1), pages)
	out := publicFlightPage{Page: page, Pages: pages, Size: size, Total: total, Flights: make([]publicSession, 0, size)}
	for i := total - 1 - (page-1)*size; i >= 0 && len(out.Flights) < size; i-- {
		out.Flights = append(out.Flights, roundedSession(s.history[i]))
	}
	return out
}

func (s *relayServer) publicFlightsHandler(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.PublicAPI || (r.Method != http.MethodGet && r.Method != http.MethodHead) {
		http.NotFound(w, r)
		return
	}
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	size, _ := strconv.Atoi(r.URL.Query().Get("size"))
	if size <= 0 {
		size = flightsPageSize
	}
	size = min(size, flightsMaxPageSize)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=5")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_ = json.NewEncoder(w).Encode(s.recentFlights(page, size))
}
