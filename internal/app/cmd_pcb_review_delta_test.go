package app

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func reviewFixture() *boardSnapshot {
	return &boardSnapshot{
		ComponentsAvailability: "available", Components: []boardComp{{UniqueID: "part-a", Pads: []boardPad{{Number: "1", Net: "GND"}}}},
		Capture: &pcbCaptureEvidence{IdentityVerified: true, ProjectUUID: "test-project", DocumentUUID: "test-board"},
		Copper:  &boardCopperSnapshot{Availability: map[string]string{"vias": "available", "fills": "available"}, Vias: []any{}, Fills: []any{}},
	}
}
func reviewFixtureVia() any {
	return map[string]any{"primitiveId": "via-a", "net": "GND", "x": 12., "y": 18.}
}
func reviewFixtureMask(layer int) any {
	return map[string]any{"primitiveId": "mask-a", "layer": layer, "source": []any{8., 14., "L", 16., 14., 16., 22., 8., 22., 8., 14.}}
}
func reviewCount(r pcbReviewDelta, kind string) int {
	n := 0
	for _, c := range r.Changes {
		if c.Kind == kind {
			n++
		}
	}
	return n
}

func TestPCBReviewDeltaUnchangedIsNotManufacturingPass(t *testing.T) {
	r := reviewPCBSnapshots(reviewFixture(), reviewFixture(), false)
	if r.Status != "no-detected-changes" || len(r.Changes) != 0 || len(r.NotChecked) == 0 {
		t.Fatalf("%+v", r)
	}
}
func TestPCBReviewDeltaRetainedMaskAtRemovedVia(t *testing.T) {
	for _, layer := range []int{5, 6} {
		b, a := reviewFixture(), reviewFixture()
		b.Copper.Vias = []any{reviewFixtureVia()}
		b.Copper.Fills = []any{reviewFixtureMask(layer)}
		a.Copper.Fills = b.Copper.Fills
		r := reviewPCBSnapshots(b, a, false)
		if r.Status != "needs-review" || reviewCount(r, "via-removed") != 1 || reviewCount(r, "retained-mask-at-removed-via") != 1 {
			t.Fatalf("layer %d: %+v", layer, r)
		}
	}
}
func TestPCBReviewDeltaCleanedMaskDoesNotRemain(t *testing.T) {
	b, a := reviewFixture(), reviewFixture()
	b.Copper.Vias = []any{reviewFixtureVia()}
	b.Copper.Fills = []any{reviewFixtureMask(5)}
	r := reviewPCBSnapshots(b, a, false)
	if reviewCount(r, "retained-mask-at-removed-via") != 0 || reviewCount(r, "via-removed") != 1 {
		t.Fatal(r)
	}
}
func TestPCBReviewDeltaPadNetAndRemoval(t *testing.T) {
	b, a := reviewFixture(), reviewFixture()
	b.Components[0].Pads = append(b.Components[0].Pads, boardPad{Number: "2", Net: "SCL"})
	a.Components[0].Pads[0].Net = "VCC"
	r := reviewPCBSnapshots(b, a, false)
	if reviewCount(r, "pad-net-changed") != 1 || reviewCount(r, "pad-removed") != 1 {
		t.Fatal(r)
	}
}
func TestPCBReviewDeltaMissingCoverageFailsClosed(t *testing.T) {
	for _, mode := range []string{"identity", "availability", "array", "component", "pad", "duplicate", "partial", "pad-availability"} {
		t.Run(mode, func(t *testing.T) {
			b, a := reviewFixture(), reviewFixture()
			switch mode {
			case "partial":
				a.Partial = []string{"missing categories"}
			case "pad-availability":
				a.Components[0].Availability = map[string]string{"pads": "unavailable"}
			case "identity":
				a.Capture = nil
			case "availability":
				delete(a.Copper.Availability, "fills")
			case "array":
				a.Copper.Vias = nil
			case "component":
				a.Components[0].UniqueID = ""
			case "pad":
				a.Components[0].Pads = nil
			case "duplicate":
				a.Components = append(a.Components, a.Components[0])
			}
			if r := reviewPCBSnapshots(b, a, false); r.Status != "incomplete" {
				t.Fatal(r)
			}
		})
	}
}
func TestPCBReviewDeltaDocumentCopyRequiresExplicitOptIn(t *testing.T) {
	b, a := reviewFixture(), reviewFixture()
	a.Capture.DocumentUUID = "copy"
	if r := reviewPCBSnapshots(b, a, false); r.Status != "incomplete" {
		t.Fatal(r)
	}
	if r := reviewPCBSnapshots(b, a, true); r.Status != "no-detected-changes" {
		t.Fatal(r)
	}
}
func TestPCBReviewDeltaUnsupportedMaskIsIncomplete(t *testing.T) {
	b, a := reviewFixture(), reviewFixture()
	b.Copper.Vias = []any{reviewFixtureVia()}
	f := map[string]any{"primitiveId": "curved-mask", "layer": 5, "source": []any{0., 0., "ARC", 180., 20., 20.}}
	b.Copper.Fills = []any{f}
	a.Copper.Fills = b.Copper.Fills
	if r := reviewPCBSnapshots(b, a, false); r.Status != "incomplete" || reviewCount(r, "retained-mask-at-removed-via") != 0 {
		t.Fatal(r)
	}
}
func TestPCBReviewDeltaContainmentIsNotBBox(t *testing.T) {
	triangle := []any{0., 0., 10., 0., 0., 10.}
	if inside, ok := reviewMaskContains(triangle, 9, 9); !ok || inside {
		t.Fatal("bbox-only false positive")
	}
	if inside, ok := reviewMaskContains(triangle, 2, 2); !ok || !inside {
		t.Fatal("inside triangle not found")
	}
	if inside, ok := reviewMaskContains(triangle, 0, 3); !ok || !inside {
		t.Fatal("edge not found")
	}
}
func TestPCBReviewDeltaStrictCommandStillEmitsJSON(t *testing.T) {
	dir := t.TempDir()
	b, a := reviewFixture(), reviewFixture()
	b.Copper.Vias = []any{reviewFixtureVia()}
	for name, s := range map[string]*boardSnapshot{"before": b, "after": a} {
		raw, _ := json.Marshal(s)
		if err := os.WriteFile(filepath.Join(dir, name+".json"), raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	var out bytes.Buffer
	c := newPcbReviewDeltaCmd(&out)
	c.SilenceErrors = true
	c.SilenceUsage = true
	c.SetArgs([]string{"--before", filepath.Join(dir, "before.json"), "--after", filepath.Join(dir, "after.json"), "--strict"})
	if err := c.Execute(); err == nil {
		t.Fatal("strict changes must exit nonzero")
	}
	var r pcbReviewDelta
	if err := json.Unmarshal(out.Bytes(), &r); err != nil || r.Status != "needs-review" {
		t.Fatalf("%v %s", err, out.String())
	}
}
