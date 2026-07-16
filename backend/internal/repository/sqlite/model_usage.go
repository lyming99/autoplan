package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"time"

	domainmodelusage "github.com/lyming99/autoplan/backend/internal/domain/modelusage"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

const modelUsageSelectColumns = `id, project_id, invocation_key, provider, model, source, operation_id,
	input_tokens, output_tokens, cached_tokens, reasoning_tokens, total_tokens, collected_at`

func (writer *Writer) TransactModelUsage(
	ctx context.Context,
	operation func(repository.ModelUsageWriteTransaction) error,
) error {
	if operation == nil {
		return repository.ErrTransaction
	}
	return writer.Transact(ctx, func(transaction repository.WriteTransaction) error {
		usage, ok := transaction.(repository.ModelUsageWriteTransaction)
		if !ok {
			return repository.ErrTransaction
		}
		return operation(usage)
	})
}

// RecordModelUsage inserts one provider invocation. An exact replay succeeds
// without a second row; reusing the key for different content is rejected.
func (transaction *writeTransaction) RecordModelUsage(
	ctx context.Context,
	value domainmodelusage.Record,
) (bool, error) {
	if value.ID != 0 || domainmodelusage.ValidateRecord(value) != nil {
		return false, repository.ErrInvalidModelUsage
	}
	projectFound, err := transaction.projectExists(ctx, value.ProjectID)
	if err != nil {
		return false, err
	}
	if !projectFound {
		return false, repository.ErrNotFound
	}

	existing, found, err := transaction.modelUsageByInvocationKey(ctx, value.InvocationKey)
	if err != nil {
		return false, err
	}
	if found {
		if sameModelUsage(existing, value) {
			return false, nil
		}
		return false, repository.ErrIdempotencyKeyReuse
	}

	if value.OperationID != nil {
		var operationProjectID sql.NullInt64
		err := transaction.tx.QueryRowContext(ctx,
			"SELECT project_id FROM operations WHERE operation_id = ?", *value.OperationID,
		).Scan(&operationProjectID)
		if errors.Is(err, sql.ErrNoRows) {
			return false, repository.ErrNotFound
		}
		if err != nil {
			return false, safeSQLError(ctx, err)
		}
		if !operationProjectID.Valid || operationProjectID.Int64 != value.ProjectID {
			return false, repository.ErrProjectMismatch
		}
	}

	current, err := transaction.projectModelUsageTotals(ctx, value.ProjectID)
	if err != nil {
		return false, err
	}
	if current.Add(value.Tokens) != nil {
		return false, repository.ErrInvalidModelUsage
	}

	result, err := transaction.tx.ExecContext(ctx, `INSERT INTO model_usage (
		project_id, invocation_key, provider, model, source, operation_id,
		input_tokens, output_tokens, cached_tokens, reasoning_tokens, total_tokens, collected_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		value.ProjectID, value.InvocationKey, value.Provider, value.Model, string(value.Source), optionalString(value.OperationID),
		optionalInt64(value.Tokens.Input), optionalInt64(value.Tokens.Output), optionalInt64(value.Tokens.Cached),
		optionalInt64(value.Tokens.Reasoning), optionalInt64(value.Tokens.Total), value.CollectedAt)
	if err != nil {
		return false, safeSQLError(ctx, err)
	}
	if err := requireOneRow(result); err != nil {
		return false, err
	}
	if err := transaction.wrote("model-usage:record"); err != nil {
		return false, err
	}
	return true, nil
}

func (transaction *writeTransaction) AggregateModelUsage(
	ctx context.Context,
	projectID int64,
	todayStartedAt, todayEndsAt string,
) (domainmodelusage.Aggregate, error) {
	result := domainmodelusage.Aggregate{
		ProjectID: projectID, TodayStartedAt: todayStartedAt, TodayEndsAt: todayEndsAt,
		ByProvider: make([]domainmodelusage.ProviderAggregate, 0),
	}
	if projectID <= 0 || domainmodelusage.ValidateAggregateWindow(todayStartedAt, todayEndsAt) != nil {
		return domainmodelusage.Aggregate{}, repository.ErrInvalidModelUsage
	}
	found, err := transaction.projectExists(ctx, projectID)
	if err != nil {
		return domainmodelusage.Aggregate{}, err
	}
	if !found {
		return domainmodelusage.Aggregate{}, repository.ErrNotFound
	}

	rows, err := transaction.tx.QueryContext(ctx, `SELECT provider,
		input_tokens, output_tokens, cached_tokens, reasoning_tokens, total_tokens, collected_at
		FROM model_usage WHERE project_id = ? ORDER BY provider ASC, collected_at ASC, id ASC`, projectID)
	if err != nil {
		return domainmodelusage.Aggregate{}, safeSQLError(ctx, err)
	}
	defer rows.Close()

	dayStart, _ := time.Parse(time.RFC3339Nano, todayStartedAt)
	dayEnd, _ := time.Parse(time.RFC3339Nano, todayEndsAt)
	providerIndex := make(map[string]int)
	for rows.Next() {
		var provider, collectedAt string
		var input, output, cached, reasoning, total sql.NullInt64
		if err := rows.Scan(&provider, &input, &output, &cached, &reasoning, &total, &collectedAt); err != nil {
			return domainmodelusage.Aggregate{}, safeSQLError(ctx, err)
		}
		tokens := nullableTokens(input, output, cached, reasoning, total)
		if domainmodelusage.ValidateRecord(domainmodelusage.Record{
			ProjectID: projectID, InvocationKey: "aggregate-validation", Provider: provider,
			Source: domainmodelusage.SourceChat, Tokens: tokens, CollectedAt: collectedAt,
		}) != nil {
			return domainmodelusage.Aggregate{}, repository.ErrInvalidStore
		}
		index, exists := providerIndex[provider]
		if !exists {
			index = len(result.ByProvider)
			providerIndex[provider] = index
			result.ByProvider = append(result.ByProvider, domainmodelusage.ProviderAggregate{Provider: provider})
		}
		if result.Cumulative.Add(tokens) != nil || result.ByProvider[index].Cumulative.Add(tokens) != nil {
			return domainmodelusage.Aggregate{}, repository.ErrInvalidStore
		}
		collectedTime, _ := time.Parse(time.RFC3339Nano, collectedAt)
		if !collectedTime.Before(dayStart) && collectedTime.Before(dayEnd) {
			if result.Today.Add(tokens) != nil || result.ByProvider[index].Today.Add(tokens) != nil {
				return domainmodelusage.Aggregate{}, repository.ErrInvalidStore
			}
		}
	}
	if err := rows.Err(); err != nil {
		return domainmodelusage.Aggregate{}, safeSQLError(ctx, err)
	}
	return result, nil
}

func (transaction *writeTransaction) modelUsageByInvocationKey(
	ctx context.Context,
	invocationKey string,
) (domainmodelusage.Record, bool, error) {
	value, err := scanModelUsage(transaction.tx.QueryRowContext(ctx,
		"SELECT "+modelUsageSelectColumns+" FROM model_usage WHERE invocation_key = ?", invocationKey))
	if errors.Is(err, sql.ErrNoRows) {
		return domainmodelusage.Record{}, false, nil
	}
	if err != nil {
		return domainmodelusage.Record{}, false, safeSQLError(ctx, err)
	}
	return value, true, nil
}

func (transaction *writeTransaction) projectModelUsageTotals(ctx context.Context, projectID int64) (domainmodelusage.Totals, error) {
	var result domainmodelusage.Totals
	err := transaction.tx.QueryRowContext(ctx, `SELECT
		COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
		COALESCE(SUM(cached_tokens), 0), COALESCE(SUM(reasoning_tokens), 0),
		COALESCE(SUM(total_tokens), 0)
		FROM model_usage WHERE project_id = ?`, projectID).Scan(
		&result.Input, &result.Output, &result.Cached, &result.Reasoning, &result.Total)
	if err != nil {
		return domainmodelusage.Totals{}, safeSQLError(ctx, err)
	}
	if result.Input < 0 || result.Output < 0 || result.Cached < 0 || result.Reasoning < 0 || result.Total < 0 {
		return domainmodelusage.Totals{}, repository.ErrInvalidStore
	}
	return result, nil
}

func scanModelUsage(row rowScanner) (domainmodelusage.Record, error) {
	var value domainmodelusage.Record
	var operationID sql.NullString
	var input, output, cached, reasoning, total sql.NullInt64
	if err := row.Scan(
		&value.ID, &value.ProjectID, &value.InvocationKey, &value.Provider, &value.Model, &value.Source, &operationID,
		&input, &output, &cached, &reasoning, &total, &value.CollectedAt,
	); err != nil {
		return domainmodelusage.Record{}, err
	}
	value.OperationID = nullStringPointer(operationID)
	value.Tokens = nullableTokens(input, output, cached, reasoning, total)
	if domainmodelusage.ValidateRecord(value) != nil {
		return domainmodelusage.Record{}, repository.ErrInvalidStore
	}
	return value, nil
}

func nullableTokens(input, output, cached, reasoning, total sql.NullInt64) domainmodelusage.Tokens {
	return domainmodelusage.Tokens{
		Input: nullInt64Pointer(input), Output: nullInt64Pointer(output), Cached: nullInt64Pointer(cached),
		Reasoning: nullInt64Pointer(reasoning), Total: nullInt64Pointer(total),
	}
}

func sameModelUsage(left, right domainmodelusage.Record) bool {
	return left.ProjectID == right.ProjectID && left.InvocationKey == right.InvocationKey &&
		left.Provider == right.Provider && left.Model == right.Model && left.Source == right.Source &&
		equalOptionalString(left.OperationID, right.OperationID) && left.CollectedAt == right.CollectedAt &&
		equalOptionalInt64(left.Tokens.Input, right.Tokens.Input) &&
		equalOptionalInt64(left.Tokens.Output, right.Tokens.Output) &&
		equalOptionalInt64(left.Tokens.Cached, right.Tokens.Cached) &&
		equalOptionalInt64(left.Tokens.Reasoning, right.Tokens.Reasoning) &&
		equalOptionalInt64(left.Tokens.Total, right.Tokens.Total)
}

func equalOptionalString(left, right *string) bool {
	return (left == nil && right == nil) || (left != nil && right != nil && *left == *right)
}

func equalOptionalInt64(left, right *int64) bool {
	return (left == nil && right == nil) || (left != nil && right != nil && *left == *right)
}

var _ repository.ModelUsageTransactional = (*Writer)(nil)
var _ repository.ModelUsageWriteTransaction = (*writeTransaction)(nil)
