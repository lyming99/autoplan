package plan

import "testing"

func TestValidatePlanStopRequiresProjectScopedIdentityAndTimestamp(t *testing.T) {
	valid := PlanStop{ProjectID: 7, PlanID: 11, UpdatedAt: "2026-07-15T00:00:05Z"}
	if err := ValidatePlanStop(valid); err != nil {
		t.Fatalf("valid stop: %v", err)
	}
	for _, input := range []PlanStop{
		{ProjectID: 0, PlanID: 11, UpdatedAt: valid.UpdatedAt},
		{ProjectID: 7, PlanID: 0, UpdatedAt: valid.UpdatedAt},
		{ProjectID: 7, PlanID: 11, UpdatedAt: "not-a-timestamp"},
	} {
		if err := ValidatePlanStop(input); err != ErrInvalidStop {
			t.Fatalf("input=%#v error=%v", input, err)
		}
	}
}
