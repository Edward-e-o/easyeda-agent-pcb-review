package app

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"reflect"
	"sort"

	"github.com/spf13/cobra"
)

// This is a read-only change review, not an electrical or manufacturing gate.
type pcbReviewDelta struct {
	Status      string            `json:"status"`
	Changes     []pcbReviewChange `json:"changes"`
	Limitations []string          `json:"limitations"`
	NotChecked  []string          `json:"notChecked"`
}
type pcbReviewChange struct {
	Kind      string `json:"kind"`
	ID        string `json:"id"`
	RelatedID string `json:"relatedId,omitempty"`
	BeforeNet string `json:"beforeNet,omitempty"`
	AfterNet  string `json:"afterNet,omitempty"`
}
type reviewVia struct {
	ID  string   `json:"primitiveId"`
	Net string   `json:"net"`
	X   *float64 `json:"x"`
	Y   *float64 `json:"y"`
}
type reviewFill struct {
	ID     string `json:"primitiveId"`
	Layer  int    `json:"layer"`
	Source []any  `json:"source"`
}

func newPcbReviewDeltaCmd(stdout io.Writer) *cobra.Command {
	var before, after string
	var strict, allowDocumentChange bool
	c := &cobra.Command{
		Use: "review-delta", Short: "Review PCB snapshot changes and retained mask openings at removed vias (offline)",
		Long: `Compare two 'pcb dump --include-copper' JSON files without contacting EDA.
Reports component/pad-network changes, removed vias, and unchanged mask fills
whose actual straight-edge polygon contains a removed via center. Such a mask
is a review candidate, not proof of unwanted exposed copper. No automatic edits.
Unsupported geometry or missing capture categories is incomplete, never pass.
This does not validate Gerbers, connectivity, DRC, firmware, or physical hardware.`,
		Example: "  easyeda pcb review-delta --before before.json --after after.json --strict",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if before == "" || after == "" {
				return fmt.Errorf("--before and --after are required")
			}
			b, err := loadBoardSnapshotPath(before)
			if err != nil {
				return fmt.Errorf("load --before: %w", err)
			}
			a, err := loadBoardSnapshotPath(after)
			if err != nil {
				return fmt.Errorf("load --after: %w", err)
			}
			report := reviewPCBSnapshots(b, a, allowDocumentChange)
			raw, err := json.MarshalIndent(report, "", "  ")
			if err != nil {
				return err
			}
			if _, err = fmt.Fprintln(stdout, string(raw)); err != nil {
				return err
			}
			if strict && report.Status != "no-detected-changes" {
				return fmt.Errorf("PCB delta review: %s", report.Status)
			}
			return nil
		},
	}
	c.Flags().StringVar(&before, "before", "", "Baseline PCB dump JSON (required)")
	c.Flags().StringVar(&after, "after", "", "Candidate PCB dump JSON (required)")
	c.Flags().BoolVar(&strict, "strict", false, "Exit nonzero on changes or incomplete coverage; JSON is still emitted")
	c.Flags().BoolVar(&allowDocumentChange, "allow-document-change", false, "Explicitly permit comparing different captured project/document identities")
	return c
}

func reviewPCBSnapshots(before, after *boardSnapshot, allowDocumentChange bool) pcbReviewDelta {
	r := pcbReviewDelta{Status: "no-detected-changes", Changes: []pcbReviewChange{}, Limitations: []string{}, NotChecked: []string{"component pose/footprint geometry", "track/via geometry and copper connectivity", "Gerber/mask copper exposure", "DRC and physical function"}}
	unknown := func(s string) { r.Limitations = append(r.Limitations, s) }
	if before == nil || after == nil {
		unknown("missing before/after snapshot")
		r.Status = "incomplete"
		return r
	}
	identity := true
	for i, s := range []*boardSnapshot{before, after} {
		label := []string{"before", "after"}[i]
		if len(s.Partial) > 0 {
			unknown(label + ": snapshot is partial")
		}
		if s.Capture == nil || !s.Capture.IdentityVerified || s.Capture.DocumentUUID == "" || s.Capture.ProjectUUID == "" {
			unknown(label + ": missing verified capture identity")
			identity = false
		}
		if s.ComponentsAvailability != "available" || s.Components == nil {
			unknown(label + ": components unavailable")
		}
		if s.Copper == nil {
			unknown(label + ": copper unavailable")
			continue
		}
		for _, k := range []string{"vias", "fills"} {
			if s.Copper.Availability[k] != "available" {
				unknown(label + ": " + k + " unavailable")
			}
		}
	}
	if identity && !allowDocumentChange && (before.Capture.DocumentUUID != after.Capture.DocumentUUID || before.Capture.ProjectUUID != after.Capture.ProjectUUID) {
		unknown("capture identities differ; use --allow-document-change only for an intentional copy comparison")
	}
	// Compare pad identities, not display names or proximity. Duplicate/absent
	// keys are unknown rather than last-write-wins or guessed identities.
	index := func(s *boardSnapshot, label string) map[string]boardComp {
		m := map[string]boardComp{}
		for _, c := range s.Components {
			if state, present := c.Availability["pads"]; present && state != "available" {
				unknown(label + ": component pads unavailable: " + c.UniqueID)
			}
			if c.UniqueID == "" {
				unknown(label + ": component without uniqueId")
				continue
			}
			if _, ok := m[c.UniqueID]; ok {
				unknown(label + ": duplicate component uniqueId " + c.UniqueID)
				continue
			}
			m[c.UniqueID] = c
		}
		return m
	}
	bcs, acs := index(before, "before"), index(after, "after")
	pads := func(c boardComp) map[string]string {
		m := map[string]string{}
		if c.Pads == nil {
			unknown("component pads unavailable: " + c.UniqueID)
		}
		for _, p := range c.Pads {
			if p.Number == "" {
				unknown("pad without number: " + c.UniqueID)
				continue
			}
			if _, ok := m[p.Number]; ok {
				unknown("duplicate pad number: " + c.UniqueID + ":" + p.Number)
			}
			m[p.Number] = p.Net
		}
		return m
	}
	for id, c := range bcs {
		a, ok := acs[id]
		if !ok {
			r.Changes = append(r.Changes, pcbReviewChange{Kind: "component-removed", ID: id})
			continue
		}
		bp, ap := pads(c), pads(a)
		for n, net := range bp {
			next, ok := ap[n]
			kind := "pad-net-changed"
			if !ok {
				kind = "pad-removed"
			}
			if !ok || next != net {
				r.Changes = append(r.Changes, pcbReviewChange{Kind: kind, ID: id + ":" + n, BeforeNet: net, AfterNet: next})
			}
		}
		for n, net := range ap {
			if _, ok := bp[n]; !ok {
				r.Changes = append(r.Changes, pcbReviewChange{Kind: "pad-added", ID: id + ":" + n, AfterNet: net})
			}
		}
	}
	for id := range acs {
		if _, ok := bcs[id]; !ok {
			r.Changes = append(r.Changes, pcbReviewChange{Kind: "component-added", ID: id})
		}
	}
	if before.Copper != nil && after.Copper != nil {
		vias := func(rows []any, label string) map[string]reviewVia {
			m := map[string]reviewVia{}
			if rows == nil {
				unknown(label + ": via array missing")
			}
			for _, row := range rows {
				var v reviewVia
				raw, e := json.Marshal(row)
				if e != nil || json.Unmarshal(raw, &v) != nil || v.ID == "" || v.X == nil || v.Y == nil {
					unknown(label + ": malformed via")
					continue
				}
				if _, ok := m[v.ID]; ok {
					unknown(label + ": duplicate via ID")
					continue
				}
				m[v.ID] = v
			}
			return m
		}
		bv, av := vias(before.Copper.Vias, "before"), vias(after.Copper.Vias, "after")
		bf := map[string]reviewFill{}
		af := map[string]reviewFill{}
		for i, rows := range [][]any{before.Copper.Fills, after.Copper.Fills} {
			label := []string{"before", "after"}[i]
			m := bf
			if i == 1 {
				m = af
			}
			if rows == nil {
				unknown(label + ": fill array missing")
			}
			for _, row := range rows {
				var f reviewFill
				raw, e := json.Marshal(row)
				if e != nil || json.Unmarshal(raw, &f) != nil || f.ID == "" {
					unknown(label + ": malformed fill")
					continue
				}
				if _, ok := m[f.ID]; ok {
					unknown(label + ": duplicate fill ID")
					continue
				}
				m[f.ID] = f
			}
		}
		for id, v := range bv {
			if a, ok := av[id]; ok {
				if v.Net != a.Net {
					r.Changes = append(r.Changes, pcbReviewChange{Kind: "via-net-changed", ID: id, BeforeNet: v.Net, AfterNet: a.Net})
				}
				continue
			}
			r.Changes = append(r.Changes, pcbReviewChange{Kind: "via-removed", ID: id, BeforeNet: v.Net})
			for fid, f := range af {
				old, ok := bf[fid]
				if !ok || !reflect.DeepEqual(f, old) || (f.Layer != 5 && f.Layer != 6) {
					continue
				}
				inside, supported := reviewMaskContains(f.Source, *v.X, *v.Y)
				if !supported {
					unknown("mask containment unsupported: " + fid)
					continue
				}
				if inside {
					r.Changes = append(r.Changes, pcbReviewChange{Kind: "retained-mask-at-removed-via", ID: fid, RelatedID: id, BeforeNet: v.Net})
				}
			}
		}
		for id, v := range av {
			if _, ok := bv[id]; !ok {
				r.Changes = append(r.Changes, pcbReviewChange{Kind: "via-added", ID: id, AfterNet: v.Net})
			}
		}
	}
	sort.Slice(r.Changes, func(i, j int) bool {
		a, b := r.Changes[i], r.Changes[j]
		if a.Kind != b.Kind {
			return a.Kind < b.Kind
		}
		if a.ID != b.ID {
			return a.ID < b.ID
		}
		return a.RelatedID < b.RelatedID
	})
	sort.Strings(r.Limitations)
	if len(r.Changes) > 0 {
		r.Status = "needs-review"
	}
	if len(r.Limitations) > 0 {
		r.Status = "incomplete"
	}
	return r
}

// Straight segments only: do not substitute a bbox for curved/holed artwork.
func reviewMaskContains(src []any, x, y float64) (bool, bool) {
	var pts [][2]float64
	for i := 0; i < len(src); {
		if token, ok := src[i].(string); ok {
			if token != "L" || len(pts) == 0 {
				return false, false
			}
			i++
			if i == len(src) {
				return false, false
			}
			continue
		}
		if i+1 >= len(src) {
			return false, false
		}
		a, ok := src[i].(float64)
		b, ok2 := src[i+1].(float64)
		if !ok || !ok2 || math.IsNaN(a) || math.IsNaN(b) || math.IsInf(a, 0) || math.IsInf(b, 0) {
			return false, false
		}
		pts = append(pts, [2]float64{a, b})
		i += 2
	}
	if len(pts) < 3 {
		return false, false
	}
	inside := false
	for i, a := range pts {
		b := pts[(i+1)%len(pts)]
		cross := (x-a[0])*(b[1]-a[1]) - (y-a[1])*(b[0]-a[0])
		if math.Abs(cross) < 1e-9 && x >= math.Min(a[0], b[0]) && x <= math.Max(a[0], b[0]) && y >= math.Min(a[1], b[1]) && y <= math.Max(a[1], b[1]) {
			return true, true
		}
		if (a[1] > y) != (b[1] > y) && x < (b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0] {
			inside = !inside
		}
	}
	return inside, true
}
