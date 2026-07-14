package bootstrap

import (
	"context"
	"encoding/json"

	applicationscripts "github.com/lyming99/autoplan/backend/internal/application/scripts"
	domainoperation "github.com/lyming99/autoplan/backend/internal/domain/operation"
	storesqlite "github.com/lyming99/autoplan/backend/internal/repository/sqlite"
)

// sqliteScriptFinalizer is the production atomic boundary between the Script
// application service and the existing P10 operation/resource archive.
type sqliteScriptFinalizer struct{ writer *storesqlite.Writer }

func (finalizer sqliteScriptFinalizer) FinalizeScriptRun(
	ctx context.Context,
	input applicationscripts.RunFinalization,
) (domainoperation.Operation, error) {
	var operation domainoperation.Operation
	exitCode, duration := input.ExitCode, input.DurationMS
	output := input.Output
	var failure *domainoperation.ErrorSummary
	if input.Target == domainoperation.StatusFailed {
		failure = &domainoperation.ErrorSummary{Code: input.FailureCode, Summary: input.Summary}
	}
	payload, err := json.Marshal(map[string]any{"status": input.Status, "failure_code": input.FailureCode})
	if err != nil {
		return operation, err
	}
	err = finalizer.writer.TransactOperations(ctx, func(transaction *storesqlite.OperationTransaction) error {
		mutation, finalizeErr := transaction.FinalizeScriptRun(ctx, storesqlite.ScriptRunFinalization{
			Transition: storesqlite.TransitionOperation{
				ProjectID: input.ProjectID, OperationID: input.OperationID, ExpectedVersion: input.ExpectedVersion,
				Target: input.Target, RequestID: input.RequestID, UpdatedAt: input.OccurredAt,
				Error: failure, Output: &output, Payload: payload,
			},
			ScriptID: input.ScriptID,
			Archive: storesqlite.RuntimeRunArchive{
				Status: input.Status, ExitCode: &exitCode, DurationMS: &duration, FailureCode: input.FailureCode,
				Output: storesqlite.RuntimeOutputArchive{
					StdoutTail: input.StdoutTail, StderrTail: input.StderrTail,
					StdoutBytes: output.StdoutBytes, StdoutLines: output.StdoutLines, StdoutTruncated: output.StdoutTruncated,
					StderrBytes: output.StderrBytes, StderrLines: output.StderrLines, StderrTruncated: output.StderrTruncated,
					RedactionFailed: output.RedactionFailed,
				},
				OccurredAt: input.OccurredAt,
			},
		})
		if finalizeErr == nil {
			operation = mutation.Operation
		}
		return finalizeErr
	})
	return operation, err
}

var _ applicationscripts.Finalizer = sqliteScriptFinalizer{}
