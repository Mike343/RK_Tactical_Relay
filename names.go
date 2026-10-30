package main

import (
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const maxNameBytes = 31

func fitName(name string, limit int) string {
	if limit < 1 {
		return ""
	}
	if len(name) <= limit {
		return name
	}
	n := limit
	for n > 0 && !utf8.RuneStart(name[n]) {
		n--
	}
	return name[:n]
}

func nameKey(name string) string {
	return strings.ToLower(strings.TrimSpace(fitName(name, maxNameBytes)))
}

func (s *relayServer) nameTakenLocked(key, id string, now time.Time) bool {
	for _, c := range s.clients {
		if c.ID != id && nameKey(c.Name) == key {
			return true
		}
	}
	for rid, rc := range s.remote {
		if rid != id && now.Sub(rc.seen) <= stateExpiry && nameKey(rc.name) == key {
			return true
		}
	}
	return false
}

func (s *relayServer) uniqueNameLocked(name, id string, now time.Time) string {
	name = strings.TrimSpace(fitName(name, maxNameBytes))
	if name == "" {
		name = "RK Pilot"
	}
	if !s.nameTakenLocked(nameKey(name), id, now) {
		return name
	}
	for n := 2; n < 10000; n++ {
		suffix := " " + strconv.Itoa(n)
		candidate := strings.TrimSpace(fitName(name, maxNameBytes-len(suffix))) + suffix
		if !s.nameTakenLocked(nameKey(candidate), id, now) {
			return candidate
		}
	}
	return strings.TrimSpace(fitName(name, maxNameBytes-9)) + " " + fitName(id, 8)
}
