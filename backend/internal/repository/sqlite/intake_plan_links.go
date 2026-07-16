package sqlite

import (
	"context"
	"database/sql"
	"sort"
	"strconv"
	"strings"

	domainintake "github.com/lyming99/autoplan/backend/internal/domain/intake"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

const planLinkSelectColumns = "id, project_id, intake_type, intake_id, plan_id, phase_index, phase_title, created_at, updated_at"

func (transaction *writeTransaction) ListPlanLinksForIntake(
	ctx context.Context,
	projectID int64,
	intakeType domainintake.Type,
	intakeID int64,
) ([]domainintake.PlanLink, error) {
	if projectID <= 0 || intakeID <= 0 || !intakeType.Valid() {
		return nil, repository.ErrInvalidIntake
	}
	links, err := transaction.listExplicitPlanLinks(ctx, projectID, intakeType, intakeID)
	if err != nil {
		return nil, err
	}
	if len(links) != 0 {
		return links, nil
	}
	// Legacy fallback is visible only when the normalized link set is absent.
	var planID sql.NullInt64
	err = transaction.tx.QueryRowContext(ctx,
		"SELECT linked_plan_id FROM "+intakeType.Table()+" WHERE project_id = ? AND id = ?",
		projectID, intakeID).Scan(&planID)
	if err == sql.ErrNoRows {
		return []domainintake.PlanLink{}, nil
	}
	if err != nil {
		return nil, safeSQLError(ctx, err)
	}
	if !planID.Valid || planID.Int64 <= 0 {
		return []domainintake.PlanLink{}, nil
	}
	var planProjectID int64
	if err := transaction.tx.QueryRowContext(ctx, "SELECT project_id FROM plans WHERE id = ?", planID.Int64).Scan(&planProjectID); err == sql.ErrNoRows {
		return []domainintake.PlanLink{}, nil
	} else if err != nil {
		return nil, safeSQLError(ctx, err)
	} else if planProjectID != projectID {
		return nil, repository.ErrProjectMismatch
	}
	return []domainintake.PlanLink{{
		ProjectID: projectID, IntakeType: intakeType, IntakeID: intakeID,
		PlanID: planID.Int64, PhaseIndex: 1,
	}}, nil
}

func (transaction *writeTransaction) listExplicitPlanLinks(
	ctx context.Context,
	projectID int64,
	intakeType domainintake.Type,
	intakeID int64,
) ([]domainintake.PlanLink, error) {
	rows, err := transaction.tx.QueryContext(ctx,
		"SELECT "+planLinkSelectColumns+` FROM intake_plan_links
		 WHERE project_id = ? AND intake_type = ? AND intake_id = ?
		 ORDER BY phase_index ASC, plan_id ASC`, projectID, string(intakeType), intakeID)
	if err != nil {
		return nil, safeSQLError(ctx, err)
	}
	defer rows.Close()
	links := make([]domainintake.PlanLink, 0)
	for rows.Next() {
		link, scanErr := scanPlanLink(rows)
		if scanErr != nil {
			return nil, safeSQLError(ctx, scanErr)
		}
		links = append(links, link)
	}
	if err := rows.Err(); err != nil {
		return nil, safeSQLError(ctx, err)
	}
	return links, nil
}

func (transaction *writeTransaction) ListIntakesForPlan(
	ctx context.Context,
	projectID int64,
	planID int64,
) ([]domainintake.IntakeRef, error) {
	if projectID <= 0 || planID <= 0 {
		return nil, repository.ErrInvalidIntake
	}
	rows, err := transaction.tx.QueryContext(ctx,
		`SELECT links.project_id, links.intake_type, links.intake_id
		   FROM intake_plan_links AS links
		  WHERE links.project_id = ? AND links.plan_id = ?
		    AND ((links.intake_type = 'requirement' AND EXISTS (
		      SELECT 1 FROM requirements WHERE id = links.intake_id AND project_id = links.project_id))
		      OR (links.intake_type = 'feedback' AND EXISTS (
		      SELECT 1 FROM feedback WHERE id = links.intake_id AND project_id = links.project_id)))
		  ORDER BY CASE links.intake_type WHEN 'requirement' THEN 0 ELSE 1 END ASC,
		           links.phase_index ASC, links.intake_id ASC`, projectID, planID)
	if err != nil {
		return nil, safeSQLError(ctx, err)
	}
	references := make([]domainintake.IntakeRef, 0)
	for rows.Next() {
		var reference domainintake.IntakeRef
		if err := rows.Scan(&reference.ProjectID, &reference.IntakeType, &reference.IntakeID); err != nil {
			_ = rows.Close()
			return nil, safeSQLError(ctx, err)
		}
		if !reference.IntakeType.Valid() {
			_ = rows.Close()
			return nil, repository.ErrInvalidStore
		}
		references = append(references, reference)
	}
	if closeErr := rows.Close(); closeErr != nil || rows.Err() != nil {
		return nil, repository.ErrTransaction
	}
	seen := make(map[string]struct{}, len(references))
	for _, reference := range references {
		seen[string(reference.IntakeType)+":"+strconv.FormatInt(reference.IntakeID, 10)] = struct{}{}
	}
	for _, intakeType := range []domainintake.Type{domainintake.Requirement, domainintake.Feedback} {
		legacyRows, queryErr := transaction.tx.QueryContext(ctx,
			`SELECT source.project_id, source.id FROM `+intakeType.Table()+` AS source
			  WHERE source.project_id = ? AND source.linked_plan_id = ?
			    AND NOT EXISTS (
			      SELECT 1 FROM intake_plan_links AS links
			       WHERE links.project_id = source.project_id
			         AND links.intake_type = ? AND links.intake_id = source.id
			    )
			  ORDER BY source.id ASC`, projectID, planID, string(intakeType))
		if queryErr != nil {
			return nil, safeSQLError(ctx, queryErr)
		}
		for legacyRows.Next() {
			var reference domainintake.IntakeRef
			reference.IntakeType = intakeType
			if err := legacyRows.Scan(&reference.ProjectID, &reference.IntakeID); err != nil {
				_ = legacyRows.Close()
				return nil, safeSQLError(ctx, err)
			}
			key := string(reference.IntakeType) + ":" + strconv.FormatInt(reference.IntakeID, 10)
			if _, duplicate := seen[key]; duplicate {
				continue
			}
			seen[key] = struct{}{}
			references = append(references, reference)
		}
		if closeErr := legacyRows.Close(); closeErr != nil || legacyRows.Err() != nil {
			return nil, repository.ErrTransaction
		}
	}
	sort.SliceStable(references, func(left, right int) bool {
		if references[left].IntakeType == references[right].IntakeType {
			return references[left].IntakeID < references[right].IntakeID
		}
		return references[left].IntakeType < references[right].IntakeType
	})
	return references, nil
}

func (transaction *writeTransaction) ReplacePlanLinks(
	ctx context.Context,
	projectID int64,
	intakeType domainintake.Type,
	intakeID int64,
	inputs []domainintake.PlanLinkInput,
	updatedAt string,
) ([]domainintake.PlanLink, error) {
	links := append([]domainintake.PlanLinkInput(nil), inputs...)
	for index := range links {
		links[index].PhaseTitle = strings.TrimSpace(links[index].PhaseTitle)
	}
	sort.SliceStable(links, func(left, right int) bool {
		if links[left].PhaseIndex == links[right].PhaseIndex {
			return links[left].PlanID < links[right].PlanID
		}
		return links[left].PhaseIndex < links[right].PhaseIndex
	})
	if domainintake.ValidatePlanLinks(projectID, intakeID, intakeType, links) != nil ||
		!domainintake.ValidUTCTimestamp(updatedAt) {
		return nil, repository.ErrLinkConflict
	}
	if _, found, err := transaction.GetIntake(ctx, projectID, intakeType, intakeID); err != nil {
		return nil, err
	} else if !found {
		return nil, repository.ErrNotFound
	}
	// Validate the whole replacement before deleting any existing link.
	for _, link := range links {
		if err := transaction.validatePlanProject(ctx, projectID, link.PlanID); err != nil {
			return nil, err
		}
	}
	existing, err := transaction.listExplicitPlanLinks(ctx, projectID, intakeType, intakeID)
	if err != nil {
		return nil, err
	}
	if samePlanLinks(existing, links) {
		return existing, nil
	}
	if _, err := transaction.tx.ExecContext(ctx,
		"DELETE FROM intake_plan_links WHERE project_id = ? AND intake_type = ? AND intake_id = ?",
		projectID, string(intakeType), intakeID); err != nil {
		return nil, safeSQLError(ctx, err)
	}
	if err := transaction.wrote("intake-links:clear"); err != nil {
		return nil, err
	}
	for _, link := range links {
		if _, err := transaction.tx.ExecContext(ctx,
			`INSERT INTO intake_plan_links
			 (project_id, intake_type, intake_id, plan_id, phase_index, phase_title, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			projectID, string(intakeType), intakeID, link.PlanID, link.PhaseIndex,
			link.PhaseTitle, updatedAt, updatedAt); err != nil {
			if safeSQLError(ctx, err) == repository.ErrDuplicate {
				return nil, repository.ErrLinkConflict
			}
			return nil, safeSQLError(ctx, err)
		}
		if err := transaction.wrote("intake-links:insert"); err != nil {
			return nil, err
		}
	}
	var legacyPlanID any
	if len(links) != 0 {
		legacyPlanID = links[0].PlanID
	}
	result, err := transaction.tx.ExecContext(ctx,
		"UPDATE "+intakeType.Table()+" SET linked_plan_id = ?, updated_at = ? WHERE project_id = ? AND id = ?",
		legacyPlanID, updatedAt, projectID, intakeID)
	if err != nil {
		return nil, safeSQLError(ctx, err)
	}
	if err := requireOneRow(result); err != nil {
		return nil, err
	}
	if err := transaction.wrote("intake-links:sync-legacy"); err != nil {
		return nil, err
	}
	return transaction.ListPlanLinksForIntake(ctx, projectID, intakeType, intakeID)
}

func samePlanLinks(existing []domainintake.PlanLink, requested []domainintake.PlanLinkInput) bool {
	if len(requested) == 0 || len(existing) != len(requested) {
		return false
	}
	for index := range requested {
		if existing[index].PlanID != requested[index].PlanID ||
			existing[index].PhaseIndex != requested[index].PhaseIndex ||
			existing[index].PhaseTitle != requested[index].PhaseTitle {
			return false
		}
	}
	return true
}

func (transaction *writeTransaction) DeletePlanLinksForIntake(
	ctx context.Context,
	projectID int64,
	intakeType domainintake.Type,
	intakeID int64,
	updatedAt string,
) error {
	if projectID <= 0 || intakeID <= 0 || !intakeType.Valid() || !domainintake.ValidUTCTimestamp(updatedAt) {
		return repository.ErrInvalidIntake
	}
	if _, found, err := transaction.GetIntake(ctx, projectID, intakeType, intakeID); err != nil {
		return err
	} else if !found {
		return repository.ErrNotFound
	}
	if _, err := transaction.tx.ExecContext(ctx,
		"DELETE FROM intake_plan_links WHERE project_id = ? AND intake_type = ? AND intake_id = ?",
		projectID, string(intakeType), intakeID); err != nil {
		return safeSQLError(ctx, err)
	}
	if err := transaction.wrote("intake-links:delete"); err != nil {
		return err
	}
	result, err := transaction.tx.ExecContext(ctx,
		"UPDATE "+intakeType.Table()+" SET linked_plan_id = NULL, updated_at = ? WHERE project_id = ? AND id = ?",
		updatedAt, projectID, intakeID)
	if err != nil {
		return safeSQLError(ctx, err)
	}
	if err := requireOneRow(result); err != nil {
		return err
	}
	return transaction.wrote("intake-links:sync-legacy")
}

func scanPlanLink(row rowScanner) (domainintake.PlanLink, error) {
	var link domainintake.PlanLink
	if err := row.Scan(
		&link.ID, &link.ProjectID, &link.IntakeType, &link.IntakeID, &link.PlanID,
		&link.PhaseIndex, &link.PhaseTitle, &link.CreatedAt, &link.UpdatedAt,
	); err != nil {
		return domainintake.PlanLink{}, err
	}
	if link.ID <= 0 || domainintake.ValidatePlanLinks(link.ProjectID, link.IntakeID, link.IntakeType,
		[]domainintake.PlanLinkInput{{PlanID: link.PlanID, PhaseIndex: link.PhaseIndex, PhaseTitle: link.PhaseTitle}}) != nil ||
		!domainintake.ValidUTCTimestamp(link.CreatedAt) || !domainintake.ValidUTCTimestamp(link.UpdatedAt) {
		return domainintake.PlanLink{}, repository.ErrInvalidStore
	}
	return link, nil
}

func (transaction *writeTransaction) validatePlanProject(ctx context.Context, projectID, planID int64) error {
	var ownerProjectID sql.NullInt64
	err := transaction.tx.QueryRowContext(ctx, "SELECT project_id FROM plans WHERE id = ?", planID).Scan(&ownerProjectID)
	if err == sql.ErrNoRows {
		return repository.ErrPlanMissing
	}
	if err != nil {
		return safeSQLError(ctx, err)
	}
	if !ownerProjectID.Valid || ownerProjectID.Int64 != projectID {
		return repository.ErrProjectMismatch
	}
	return nil
}
