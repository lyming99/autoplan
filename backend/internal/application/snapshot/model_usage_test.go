package snapshot

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/lyming99/autoplan/backend/internal/domain/contracts"
	domainmodelusage "github.com/lyming99/autoplan/backend/internal/domain/modelusage"
)

type modelUsageQueryFixture struct {
	aggregate domainmodelusage.Aggregate
	start     string
	end       string
}

func (fixture *modelUsageQueryFixture) AggregateModelUsage(_ context.Context, projectID int64, start, end string) (domainmodelusage.Aggregate, error) {
	fixture.start, fixture.end = start, end
	fixture.aggregate.ProjectID = projectID
	return fixture.aggregate, nil
}

func TestModelUsageSnapshotMapsStrongTypesAndLocalDay(t *testing.T) {
	fixture := &modelUsageQueryFixture{aggregate: domainmodelusage.Aggregate{
		Cumulative: domainmodelusage.Totals{Input: 20, Output: 8, Cached: 3, Reasoning: 2, Total: 33},
		Today:      domainmodelusage.Totals{Input: 5, Output: 2, Total: 7},
		ByProvider: []domainmodelusage.ProviderAggregate{{
			Provider: "openai", Cumulative: domainmodelusage.Totals{Input: 20, Output: 8, Cached: 3, Reasoning: 2, Total: 33},
			Today: domainmodelusage.Totals{Input: 5, Output: 2, Total: 7},
		}},
	}}
	location := time.FixedZone("fixture", 8*60*60)
	previousLocal := time.Local
	time.Local = location
	t.Cleanup(func() { time.Local = previousLocal })
	result, err := modelUsageSnapshot(context.Background(), fixture, 7, time.Date(2026, 7, 15, 10, 0, 0, 0, location))
	if err != nil {
		t.Fatal(err)
	}
	if result.Cumulative.TotalTokens != 33 || result.Today.InputTokens != 5 ||
		len(result.ByProvider) != 1 || result.ByProvider[0].Today.OutputTokens != 2 {
		t.Fatalf("usage projection=%#v", result)
	}
	if fixture.start != "2026-07-14T16:00:00Z" || fixture.end != "2026-07-15T16:00:00Z" {
		t.Fatalf("aggregate window=%q..%q", fixture.start, fixture.end)
	}
}

func TestEmptySnapshotSerializesStableZeroModelUsage(t *testing.T) {
	content, err := json.Marshal(emptySnapshot(nil, contracts.SanitizedObject{}))
	if err != nil {
		t.Fatal(err)
	}
	var value struct {
		ModelUsage contracts.ModelUsageSummary `json:"modelUsage"`
	}
	if err := json.Unmarshal(content, &value); err != nil {
		t.Fatal(err)
	}
	if value.ModelUsage.Cumulative != (contracts.ModelUsageTotals{}) ||
		value.ModelUsage.Today != (contracts.ModelUsageTotals{}) || value.ModelUsage.ByProvider == nil ||
		len(value.ModelUsage.ByProvider) != 0 {
		t.Fatalf("empty model usage=%#v JSON=%s", value.ModelUsage, content)
	}
}
