package main

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
)

type number struct {
	v  float64
	ok bool
}

func (n *number) UnmarshalJSON(b []byte) error {
	n.v, n.ok = 0, false
	raw := strings.TrimSpace(string(b))
	if raw == "null" {
		return nil
	}
	var f float64
	if json.Unmarshal(b, &f) != nil {
		var s string
		if json.Unmarshal(b, &s) != nil {
			return nil
		}
		parsed, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
		if err != nil {
			return nil
		}
		f = parsed
	}
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return nil
	}
	n.v, n.ok = f, true
	return nil
}

func (n number) inRange(lo, hi float64) bool {
	return n.ok && n.v >= lo && n.v <= hi
}

func (n number) unsigned(upper uint32) (uint32, bool) {
	if !n.ok || n.v != math.Trunc(n.v) || n.v < 0 || n.v > float64(upper) {
		return 0, false
	}
	return uint32(n.v), true
}

type text string

func (t *text) UnmarshalJSON(b []byte) error {
	*t = ""
	var s string
	if json.Unmarshal(b, &s) == nil {
		*t = text(s)
		return nil
	}
	var f float64
	if json.Unmarshal(b, &f) == nil {
		*t = text(strings.TrimSpace(string(b)))
	}
	return nil
}

type wireMessage struct {
	Type         text   `json:"type"`
	Protocol     number `json:"protocol"`
	ID           text   `json:"id"`
	Name         text   `json:"name"`
	Lat          number `json:"lat"`
	Lon          number `json:"lon"`
	AltFt        number `json:"altFt"`
	Heading      number `json:"heading"`
	SpeedKts     number `json:"speedKts"`
	Aircraft     text   `json:"aircraft"`
	Event        number `json:"event"`
	Weapon       number `json:"weapon"`
	Target       number `json:"target"`
	WeaponID     number `json:"weaponId"`
	Flags        number `json:"flags"`
	Damage       number `json:"damage"`
	Duration     number `json:"duration"`
	MissDistance number `json:"missDistance"`
}

func num(v float64) number { return number{v, true} }
