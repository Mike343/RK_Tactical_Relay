package main

import (
	"encoding/binary"
	"fmt"
	"hash/fnv"
	"strings"
	"time"
)

const (
	staleAfter    = 5 * time.Second
	noStateAfter  = 20 * time.Second
	viewLogGap    = time.Second
	dropLogGap    = 3 * time.Second
	roomLogEvery  = 6
	maxViewNames  = 12
	stateDropGap  = 5 * time.Second
	flagTeamMask  = 3
	teamRulesOpen = "open"
)

func (s *relayServer) tracing() bool {
	return s.cfg.LogLevel >= 1
}

func (s *relayServer) openTeams() bool {
	return s.cfg.TeamRules != "strict"
}

func (s *relayServer) noteView(c *relayClient, team uint32, b []byte) {
	if !s.tracing() {
		return
	}
	count := int(binary.LittleEndian.Uint32(b[16:20]))
	h := fnv.New64a()
	for i := 0; i < count; i++ {
		o := 24 + i*contactSize
		_, _ = h.Write(b[o : o+8])
	}
	sig := h.Sum64() ^ uint64(count)
	now := time.Now()
	if sig == c.viewSig || now.Sub(c.viewLogged) < viewLogGap {
		return
	}
	c.viewSig = sig
	c.viewLogged = now
	var names []string
	tracked := 0
	for i := 0; i < count; i++ {
		o := 24 + i*contactSize
		flags := binary.LittleEndian.Uint32(b[o+4 : o+8])
		visible := flags&flagTracked != 0
		if visible {
			tracked++
		}
		if len(names) < maxViewNames {
			state := "hidden"
			if visible {
				state = "tracked"
			}
			names = append(names, fmt.Sprintf("%s(t%d,%s)", nulString(b[o+40:o+72]), flags&flagTeamMask, state))
		}
	}
	s.logEvent("VIEW viewer=%q team=%d contacts=%d tracked=%d [%s]", c.Name, team, count, tracked, strings.Join(names, " "))
}

func nulString(b []byte) string {
	for i, v := range b {
		if v == 0 {
			return string(b[:i])
		}
	}
	return string(b)
}

func (s *relayServer) logStateDrop(c *relayClient, reason string) {
	if !s.tracing() {
		return
	}
	now := time.Now()
	if now.Sub(c.dropLogged) < stateDropGap {
		return
	}
	c.dropLogged = now
	s.logEvent("STATE_DROP name=%q reason=%s", c.Name, reason)
}

type heartbeatView struct {
	c         *relayClient
	hasState  bool
	stateAge  time.Duration
	connected time.Duration
}

func (s *relayServer) traceHeartbeat(views []heartbeatView, ticks int) {
	if !s.tracing() {
		return
	}
	flying := 0
	for _, v := range views {
		switch {
		case v.hasState && v.stateAge > staleAfter:
			if !v.c.staleLogged.Swap(true) {
				s.logEvent("STATE_STALE name=%q silent=%ds (connected but no position updates)", v.c.Name, int(v.stateAge.Seconds()))
			}
		case v.hasState:
			flying++
		case v.connected > noStateAfter:
			if !v.c.noStateLogged.Swap(true) {
				s.logEvent("NO_STATE name=%q connected=%ds (never sent a position)", v.c.Name, int(v.connected.Seconds()))
			}
		}
	}
	if len(views) > 0 && ticks%roomLogEvery == 0 {
		counts := s.counts.load()
		s.logEvent("ROOM users=%d flying=%d peers=%d snapshots=%d dropped=%d states=%d combat=%d", len(views), flying, s.peerCount(), counts.Snapshot, counts.SnapshotsDropped, counts.State, counts.Combat)
	}
}
