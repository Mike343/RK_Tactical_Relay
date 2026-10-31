package main

import (
	"math"
	"time"
)

const (
	detectRangeMiles = 100.0
	detectHalfAngle  = 60.0
	flagTracked      = 4
)

func coneDetects(a, b *aircraftState, miles float64) bool {
	const rad = math.Pi / 180
	dlat := (b.Lat - a.Lat) * rad
	dlon := (math.Mod(b.Lon-a.Lon+540, 360) - 180) * rad
	h := math.Pow(math.Sin(dlat/2), 2) + math.Cos(a.Lat*rad)*math.Cos(b.Lat*rad)*math.Pow(math.Sin(dlon/2), 2)
	horizontal := 3958.7613 * 2 * math.Asin(math.Sqrt(math.Min(1, h)))
	if math.Hypot(horizontal, (b.AltFt-a.AltFt)/5280) > miles {
		return false
	}
	bearing := math.Atan2(math.Sin(dlon)*math.Cos(b.Lat*rad), math.Cos(a.Lat*rad)*math.Sin(b.Lat*rad)-math.Sin(a.Lat*rad)*math.Cos(b.Lat*rad)*math.Cos(dlon)) / rad
	return math.Abs(math.Mod(bearing-a.Heading+540, 360)-180) <= detectHalfAngle
}

func teamsInteract(a, b, weapon uint32) bool {
	return (a == 0) == (b == 0) && !(a != 0 && a == b && weapon == 1)
}

func teamDetects(viewerTeam uint32, target *contact, allies []*contact) bool {
	if viewerTeam == 0 || viewerTeam == target.team {
		return true
	}
	for _, ally := range allies {
		for _, id := range ally.detected {
			if id == target.panel {
				return true
			}
		}
		if coneDetects(&ally.state, &target.state, detectRangeMiles) {
			return true
		}
	}
	return false
}

func alliesOf(team uint32, contacts []contact) []*contact {
	if team == 0 {
		return nil
	}
	var out []*contact
	for i := range contacts {
		if contacts[i].team == team {
			out = append(out, &contacts[i])
		}
	}
	return out
}

func (s *relayServer) combatContext(target, team uint32, wantAllies bool, now time.Time) (*contact, bool, []*contact) {
	var victim *contact
	var allies []*contact
	hasState := false
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, c := range s.clients {
		fresh := c.State != nil && now.Sub(c.LastState) <= stateExpiry
		if c.Source == target {
			v := contact{id: c.ID, name: c.Name, team: c.Team, panel: c.Source}
			if fresh {
				v.state = *c.State
				hasState = true
			}
			victim = &v
		}
		if wantAllies && team != 0 && fresh && c.Team == team {
			allies = append(allies, &contact{team: c.Team, detected: c.Detected, state: *c.State, panel: c.Source})
		}
	}
	for _, rc := range s.remote {
		if now.Sub(rc.seen) > stateExpiry {
			continue
		}
		if victim == nil && rc.panel == target {
			v := rc.contact
			victim = &v
			hasState = true
		}
		if wantAllies && team != 0 && rc.team == team {
			a := rc.contact
			allies = append(allies, &a)
		}
	}
	return victim, hasState, allies
}

func (s *relayServer) teamsMayFight(a, b, weapon uint32) bool {
	if s.openTeams() {
		return !(a != 0 && a == b && weapon == 1)
	}
	return teamsInteract(a, b, weapon)
}
