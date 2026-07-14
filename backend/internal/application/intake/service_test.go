package intake

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	applicationidempotency "github.com/lyming99/autoplan/backend/internal/application/idempotency"
	applicationsnapshot "github.com/lyming99/autoplan/backend/internal/application/snapshot"
	domainconfig "github.com/lyming99/autoplan/backend/internal/domain/config"
	domainintake "github.com/lyming99/autoplan/backend/internal/domain/intake"
	domainproject "github.com/lyming99/autoplan/backend/internal/domain/project"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

const applicationTestTime = "2026-07-11T09:00:00.000Z"

type fixedClock struct{ value time.Time }

func (clock fixedClock) Now() time.Time { return clock.value }

func TestCreateUsesOneTransactionAndRereadsCommittedSnapshot(t *testing.T) {
	store := newMemoryStore()
	service := newTestService(store, nil, nil)
	result, err := service.Create(context.Background(), CreateCommand{
		ProjectID: 1, Type: domainintake.Requirement, Body: "Default title\nBody",
		Metadata: MutationMetadata{CallerScope: "test", IdempotencyKey: "create-1", RequestID: "request-1"},
	}, domainproject.Visibility{})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Snapshot.Requirements) != 1 || store.businessCommits != 1 || store.readCommits != 1 || len(store.events) != 1 {
		t.Fatalf("snapshot=%#v business=%d reads=%d events=%d", result.Snapshot.Requirements, store.businessCommits, store.readCommits, len(store.events))
	}
	var title string
	if json.Unmarshal(result.Snapshot.Requirements[0]["title"], &title) != nil || title != "Default title" {
		t.Fatalf("default title = %q", title)
	}
}

func TestIdempotentCreateReplaysWithoutSecondBusinessWrite(t *testing.T) {
	store := newMemoryStore()
	service := newTestService(store, nil, nil)
	command := CreateCommand{
		ProjectID: 1, Type: domainintake.Requirement, Title: "Idempotent", Body: "Body",
		Metadata: MutationMetadata{CallerScope: "test", IdempotencyKey: "same-key", RequestID: "request-1"},
	}
	if _, err := service.Create(context.Background(), command, domainproject.Visibility{}); err != nil {
		t.Fatal(err)
	}
	service.clock = fixedClock{value: time.Date(2026, 7, 11, 9, 5, 0, 0, time.UTC)}
	if _, err := service.Create(context.Background(), command, domainproject.Visibility{}); err != nil {
		t.Fatal(err)
	}
	if len(store.intakes) != 1 || store.businessCommits != 1 || len(store.events) != 1 {
		t.Fatalf("intakes=%d commits=%d events=%d", len(store.intakes), store.businessCommits, len(store.events))
	}
	command.Body = "different"
	if _, err := service.Create(context.Background(), command, domainproject.Visibility{}); !errors.Is(err, repository.ErrIdempotencyKeyReuse) {
		t.Fatalf("key reuse error = %v", err)
	}
}

func TestRetryPlanGenerationClearsFailureStateIdempotently(t *testing.T) {
	store := newMemoryStore()
	failedAt := applicationTestTime
	failure := "plan_generation_failed"
	store.seedIntake(domainintake.Intake{
		ID: 8, ProjectID: 1, Type: domainintake.Requirement, Title: "Retry", Body: "Body",
		Status: domainintake.StatusDraft, CreatedAt: applicationTestTime, UpdatedAt: applicationTestTime,
		Failure: domainintake.GenerationFailure{Count: 3, LastFailedAt: &failedAt, LastError: &failure},
	})
	service := newTestService(store, nil, nil)
	command := RetryPlanGenerationCommand{
		ProjectID: 1, Type: domainintake.Requirement, ID: 8,
		Metadata: MutationMetadata{CallerScope: "test", IdempotencyKey: "retry-8", RequestID: "request-retry-8"},
	}
	result, err := service.RetryPlanGeneration(context.Background(), command, domainproject.Visibility{})
	if err != nil {
		t.Fatal(err)
	}
	updated := store.intakes[intakeKey(domainintake.Requirement, 8)]
	if updated.Failure.Count != 0 || updated.Failure.LastError != nil || updated.Failure.LastFailedAt != nil || len(result.Snapshot.Requirements) != 1 {
		t.Fatalf("failure=%#v snapshot=%#v", updated.Failure, result.Snapshot.Requirements)
	}
	commits, events := store.businessCommits, len(store.events)
	if _, err := service.RetryPlanGeneration(context.Background(), command, domainproject.Visibility{}); err != nil {
		t.Fatal(err)
	}
	if store.businessCommits != commits || len(store.events) != events {
		t.Fatalf("idempotent retry wrote twice: commits=%d/%d events=%d/%d", commits, store.businessCommits, events, len(store.events))
	}
}

func TestConcurrentIdempotentCreateCommitsOnce(t *testing.T) {
	store := newMemoryStore()
	service := newTestService(store, nil, nil)
	command := CreateCommand{
		ProjectID: 1, Type: domainintake.Requirement, Title: "Concurrent", Body: "Body",
		Metadata: MutationMetadata{CallerScope: "test", IdempotencyKey: "concurrent-key", RequestID: "request-concurrent"},
	}
	errorsFound := make(chan error, 8)
	var workers sync.WaitGroup
	for index := 0; index < 8; index++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			_, err := service.Create(context.Background(), command, domainproject.Visibility{})
			errorsFound <- err
		}()
	}
	workers.Wait()
	close(errorsFound)
	for err := range errorsFound {
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(store.intakes) != 1 || store.businessCommits != 1 || len(store.events) != 1 {
		t.Fatalf("intakes=%d commits=%d events=%d", len(store.intakes), store.businessCommits, len(store.events))
	}
}

func TestCreateReturnsFrozenDuplicateIdentity(t *testing.T) {
	store := newMemoryStore()
	store.seedIntake(domainintake.Intake{
		ID: 9, ProjectID: 1, Type: domainintake.Requirement, Title: "Same title", Body: "same body",
		Status: domainintake.StatusOpen, CreatedAt: applicationTestTime, UpdatedAt: applicationTestTime,
	})
	service := newTestService(store, nil, nil)
	_, err := service.Create(context.Background(), CreateCommand{
		ProjectID: 1, Type: domainintake.Requirement, Title: " Same   title ", Body: "same\tbody",
	}, domainproject.Visibility{})
	var duplicate DuplicateError
	if !errors.As(err, &duplicate) || duplicate.IntakeType != domainintake.Requirement || duplicate.Existing.ID != 9 ||
		!errors.Is(err, repository.ErrDuplicate) {
		t.Fatalf("duplicate error = %#v", err)
	}
}

func TestQueriesAndFeedbackAssociationKeepProjectBoundary(t *testing.T) {
	store := newMemoryStore()
	store.seedIntake(domainintake.Intake{
		ID: 9, ProjectID: 2, Type: domainintake.Requirement, Title: "Other project", Body: "Body",
		Status: domainintake.StatusOpen, CreatedAt: applicationTestTime, UpdatedAt: applicationTestTime,
	})
	service := newTestService(store, nil, nil)
	if _, err := service.Get(context.Background(), 1, domainintake.Requirement, 9); !errors.Is(err, repository.ErrNotFound) {
		t.Fatalf("cross-project get error = %v", err)
	}
	requirementID := int64(9)
	if _, err := service.Create(context.Background(), CreateCommand{
		ProjectID: 1, Type: domainintake.Feedback, RequirementID: &requirementID,
		Title: "Feedback", Body: "Body",
	}, domainproject.Visibility{}); !errors.Is(err, repository.ErrProjectMismatch) {
		t.Fatalf("cross-project association error = %v", err)
	}
}

func TestUpdateRejectsStaleStateAndInvalidTransition(t *testing.T) {
	store := newMemoryStore()
	store.seedIntake(domainintake.Intake{
		ID: 1, ProjectID: 1, Type: domainintake.Requirement, Title: "Before", Body: "Body",
		Status: domainintake.StatusOpen, CreatedAt: applicationTestTime, UpdatedAt: applicationTestTime,
	})
	service := newTestService(store, nil, nil)
	title := "After"
	if _, err := service.Update(context.Background(), UpdateCommand{
		ProjectID: 1, Type: domainintake.Requirement, ID: 1,
		ExpectedUpdatedAt: "2026-07-11T08:59:59.000Z", Title: &title,
	}, domainproject.Visibility{}); !errors.Is(err, ErrStateConflict) {
		t.Fatalf("stale error = %v", err)
	}
	draft := domainintake.StatusDraft
	if _, err := service.Update(context.Background(), UpdateCommand{
		ProjectID: 1, Type: domainintake.Requirement, ID: 1,
		ExpectedUpdatedAt: applicationTestTime, Status: &draft,
	}, domainproject.Visibility{}); !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("transition error = %v", err)
	}
	if store.intakes[intakeKey(domainintake.Requirement, 1)].Title != "Before" {
		t.Fatal("failed updates changed the row")
	}
}

func TestReplaceLinksAndSnapshotUseDeterministicPhaseOrder(t *testing.T) {
	store := newMemoryStore()
	store.seedIntake(domainintake.Intake{
		ID: 1, ProjectID: 1, Type: domainintake.Requirement, Title: "Requirement", Body: "Body",
		Status: domainintake.StatusOpen, CreatedAt: applicationTestTime, UpdatedAt: applicationTestTime,
	})
	service := newTestService(store, nil, nil)
	result, err := service.ReplaceLinks(context.Background(), ReplaceLinksCommand{
		ProjectID: 1, Type: domainintake.Requirement, ID: 1,
		Links: []domainintake.PlanLinkInput{
			{PlanID: 20, PhaseIndex: 2, PhaseTitle: "  Implement  "},
			{PlanID: 10, PhaseIndex: 1, PhaseTitle: "Discover"},
			{PlanID: 20, PhaseIndex: 3, PhaseTitle: "ignored duplicate"},
		},
	}, domainproject.Visibility{})
	if err != nil {
		t.Fatal(err)
	}
	links := store.links[intakeKey(domainintake.Requirement, 1)]
	if len(links) != 2 || links[0].PlanID != 10 || links[1].PlanID != 20 || links[1].PhaseTitle != "Implement" ||
		len(result.Snapshot.Requirements) != 1 {
		t.Fatalf("links=%#v snapshot=%#v", links, result.Snapshot.Requirements)
	}
}

func TestDeleteReportsRecoverableAttachmentCleanupAfterCommit(t *testing.T) {
	store := newMemoryStore()
	store.seedIntake(domainintake.Intake{
		ID: 1, ProjectID: 1, Type: domainintake.Requirement, Title: "Requirement", Body: "Body",
		Status: domainintake.StatusOpen, CreatedAt: applicationTestTime, UpdatedAt: applicationTestTime,
	})
	runtime := &runtimeSpy{}
	workflow := &attachmentWorkflowSpy{finalizeError: errors.New("synthetic cleanup failure")}
	service := newTestService(store, runtime, workflow)
	result, err := service.Delete(context.Background(), DeleteCommand{
		ProjectID: 1, Type: domainintake.Requirement, ID: 1,
		Metadata: MutationMetadata{CallerScope: "test", IdempotencyKey: "delete-1", RequestID: "request-delete"},
	}, domainproject.Visibility{})
	if err != nil {
		t.Fatal(err)
	}
	if _, exists := store.intakes[intakeKey(domainintake.Requirement, 1)]; exists ||
		result.Cleanup == nil || result.Cleanup.Status != "recovery_required" || result.Cleanup.Pending != 1 ||
		runtime.calls != 1 || workflow.prepareCalls != 1 || workflow.finalizeCalls != 1 {
		t.Fatalf("cleanup=%#v runtime=%d prepare=%d finalize=%d", result.Cleanup, runtime.calls, workflow.prepareCalls, workflow.finalizeCalls)
	}
	if _, err := service.Delete(context.Background(), DeleteCommand{
		ProjectID: 1, Type: domainintake.Requirement, ID: 1,
		Metadata: MutationMetadata{CallerScope: "test", IdempotencyKey: "delete-1", RequestID: "request-delete"},
	}, domainproject.Visibility{}); err != nil {
		t.Fatal(err)
	}
	if runtime.calls != 1 || workflow.prepareCalls != 1 || workflow.finalizeCalls != 2 || len(store.events) != 1 {
		t.Fatalf("replay runtime=%d prepare=%d finalize=%d events=%d", runtime.calls, workflow.prepareCalls, workflow.finalizeCalls, len(store.events))
	}
}

func TestDeleteRollbackDoesNotFinalizeAttachmentBytes(t *testing.T) {
	store := newMemoryStore()
	store.seedIntake(domainintake.Intake{
		ID: 1, ProjectID: 1, Type: domainintake.Requirement, Title: "Requirement", Body: "Body",
		Status: domainintake.StatusOpen, CreatedAt: applicationTestTime, UpdatedAt: applicationTestTime,
	})
	store.deleteError = errors.New("synthetic database failure")
	runtime := &runtimeSpy{}
	workflow := &attachmentWorkflowSpy{}
	service := newTestService(store, runtime, workflow)
	if _, err := service.Delete(context.Background(), DeleteCommand{
		ProjectID: 1, Type: domainintake.Requirement, ID: 1,
	}, domainproject.Visibility{}); !errors.Is(err, store.deleteError) {
		t.Fatalf("delete error = %v", err)
	}
	if _, exists := store.intakes[intakeKey(domainintake.Requirement, 1)]; !exists ||
		workflow.prepareCalls != 1 || workflow.finalizeCalls != 0 || len(store.events) != 0 {
		t.Fatalf("exists=%v prepare=%d finalize=%d events=%d", exists, workflow.prepareCalls, workflow.finalizeCalls, len(store.events))
	}
}

func TestSnapshotDoesNotExposePrivateIntakeFields(t *testing.T) {
	store := newMemoryStore()
	secret := "synthetic-auth-value"
	logRef := "private-log-reference"
	store.seedIntake(domainintake.Intake{
		ID: 1, ProjectID: 1, Type: domainintake.Feedback, Title: "Feedback", Body: "Body",
		Status: domainintake.StatusOpen, CreatedAt: applicationTestTime, UpdatedAt: applicationTestTime,
		PlanGeneration: domainintake.PlanGenerationConfig{ClaudeAuthToken: secret},
		Failure:        domainintake.GenerationFailure{LastLogRef: &logRef}, SourceRef: &logRef, SourceDigest: &secret,
	})
	service := newTestService(store, nil, nil)
	snapshot, err := service.Snapshot(context.Background(), 1, domainproject.Visibility{})
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(snapshot)
	text := string(encoded)
	for _, forbidden := range []string{secret, logRef, "source_path", "source_hash", "last_generate_log_file"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("snapshot leaked %q", forbidden)
		}
	}
}

func TestSnapshotAttachmentProjectionContainsOnlyPublicFields(t *testing.T) {
	store := newMemoryStore()
	clockValue, _ := time.Parse(time.RFC3339Nano, applicationTestTime)
	assembler := applicationsnapshot.NewWithAttachments(
		applicationsnapshot.TransactionalIntakeReader(store),
		attachmentSnapshotSource{values: []applicationsnapshot.AttachmentSnapshot{{
			ID: 7, DisplayName: "evidence.txt", Size: 12, MIMEType: "text/plain",
			DownloadURL: "/api/v1/attachments/7/content",
		}}},
	)
	service := NewService(Dependencies{
		Assembler: assembler, Writer: store, Idempotency: applicationidempotency.New(), Clock: fixedClock{clockValue},
	})
	snapshot, err := service.Snapshot(context.Background(), 1, domainproject.Visibility{})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Attachments) != 1 || len(snapshot.Attachments[0]) != 5 {
		t.Fatalf("attachment projection = %#v", snapshot.Attachments)
	}
	for _, key := range []string{"id", "display_name", "size", "mime_type", "download_url"} {
		if _, exists := snapshot.Attachments[0][key]; !exists {
			t.Fatalf("attachment field %q is missing", key)
		}
	}
}

func newTestService(store *memoryStore, runtime PlanRuntime, workflow AttachmentWorkflow) *Service {
	assembler := applicationsnapshot.New(applicationsnapshot.TransactionalIntakeReader(store))
	clockValue, _ := time.Parse(time.RFC3339Nano, applicationTestTime)
	return NewService(Dependencies{
		Assembler: assembler, Writer: store, Idempotency: applicationidempotency.New(),
		Runtime: runtime, Attachments: workflow, Clock: fixedClock{clockValue},
	})
}

type runtimeSpy struct{ calls int }

func (runtime *runtimeSpy) StopIntakePlans(context.Context, int64, domainintake.Type, int64) ([]int64, error) {
	runtime.calls++
	return []int64{10}, nil
}

type attachmentWorkflowSpy struct {
	prepareCalls  int
	finalizeCalls int
	finalizeError error
}

type attachmentSnapshotSource struct {
	values []applicationsnapshot.AttachmentSnapshot
}

func (source attachmentSnapshotSource) ListAttachmentSnapshots(context.Context, int64) ([]applicationsnapshot.AttachmentSnapshot, error) {
	return append([]applicationsnapshot.AttachmentSnapshot(nil), source.values...), nil
}

func (workflow *attachmentWorkflowSpy) PrepareIntakeDeletion(
	_ context.Context, projectID int64, intakeType domainintake.Type, intakeID int64, operationID string,
) (AttachmentDeletion, error) {
	workflow.prepareCalls++
	return AttachmentDeletion{
		OperationID: operationID, ProjectID: projectID, IntakeType: intakeType,
		IntakeID: intakeID, AttachmentIDs: []int64{7},
	}, nil
}

func (workflow *attachmentWorkflowSpy) FinalizeIntakeDeletion(
	context.Context, AttachmentDeletion,
) (AttachmentCleanup, error) {
	workflow.finalizeCalls++
	return AttachmentCleanup{Total: 1, Pending: 1}, workflow.finalizeError
}

type memoryStore struct {
	mu              sync.Mutex
	closed          bool
	project         repository.Project
	state           repository.ProjectState
	intakes         map[string]domainintake.Intake
	links           map[string][]domainintake.PlanLink
	operations      map[string]repository.IdempotencyRecord
	events          []domainintake.PendingEvent
	nextID          int64
	businessCommits int
	readCommits     int
	deleteError     error
}

type memoryTransaction struct {
	repository.WriteTransaction
	store *memoryStore
	wrote bool
}

func newMemoryStore() *memoryStore {
	project := repository.Project{ID: 1, Name: "Synthetic", CreatedAt: applicationTestTime, UpdatedAt: applicationTestTime}
	state, _ := domainconfig.DefaultProjectState(1, applicationTestTime)
	return &memoryStore{
		project: project, state: state, intakes: make(map[string]domainintake.Intake),
		links: make(map[string][]domainintake.PlanLink), operations: make(map[string]repository.IdempotencyRecord), nextID: 1,
	}
}

func (store *memoryStore) seedIntake(value domainintake.Intake) {
	store.intakes[intakeKey(value.Type, value.ID)] = value
	if value.ID >= store.nextID {
		store.nextID = value.ID + 1
	}
}

func (store *memoryStore) Check(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if store.closed {
		return repository.ErrClosed
	}
	return nil
}

func (store *memoryStore) TransactIntake(ctx context.Context, operation func(repository.IntakeWriteTransaction) error) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.Check(ctx); err != nil {
		return err
	}
	copy := store.clone()
	transaction := &memoryTransaction{store: copy}
	if err := operation(transaction); err != nil {
		return err
	}
	store.intakes, store.links, store.operations, store.events, store.nextID =
		copy.intakes, copy.links, copy.operations, copy.events, copy.nextID
	if transaction.wrote {
		store.businessCommits++
	} else {
		store.readCommits++
	}
	return nil
}

func (store *memoryStore) clone() *memoryStore {
	copy := newMemoryStore()
	copy.project, copy.state, copy.nextID = store.project, store.state, store.nextID
	copy.deleteError = store.deleteError
	for key, value := range store.intakes {
		copy.intakes[key] = value
	}
	for key, value := range store.links {
		copy.links[key] = append([]domainintake.PlanLink(nil), value...)
	}
	for key, value := range store.operations {
		copy.operations[key] = value
	}
	copy.events = append([]domainintake.PendingEvent(nil), store.events...)
	return copy
}

func (store *memoryStore) Close() error { store.closed = true; return nil }

func (transaction *memoryTransaction) ListProjects(context.Context) ([]repository.Project, error) {
	return []repository.Project{transaction.store.project}, nil
}
func (transaction *memoryTransaction) GetProject(_ context.Context, id int64) (repository.Project, bool, error) {
	return transaction.store.project, id == transaction.store.project.ID, nil
}
func (transaction *memoryTransaction) ListSettings(context.Context, string) ([]repository.Setting, error) {
	return []repository.Setting{}, nil
}
func (transaction *memoryTransaction) GetProjectState(_ context.Context, id int64) (repository.ProjectState, bool, error) {
	return transaction.store.state, id == transaction.store.state.ProjectID, nil
}

func (transaction *memoryTransaction) ListIntakes(_ context.Context, options domainintake.ListOptions) ([]domainintake.Intake, error) {
	result := make([]domainintake.Intake, 0)
	for _, value := range transaction.store.intakes {
		if value.ProjectID == options.ProjectID && value.Type == options.Type && (options.Status == nil || value.Status == *options.Status) {
			result = append(result, value)
		}
	}
	sort.SliceStable(result, func(left, right int) bool {
		if result[left].UpdatedAt == result[right].UpdatedAt {
			return result[left].ID > result[right].ID
		}
		return result[left].UpdatedAt > result[right].UpdatedAt
	})
	start := options.Offset
	if start > len(result) {
		start = len(result)
	}
	end := len(result)
	if options.Limit > 0 && start+options.Limit < end {
		end = start + options.Limit
	}
	return append([]domainintake.Intake(nil), result[start:end]...), nil
}

func (transaction *memoryTransaction) GetIntake(_ context.Context, projectID int64, intakeType domainintake.Type, intakeID int64) (domainintake.Intake, bool, error) {
	value, exists := transaction.store.intakes[intakeKey(intakeType, intakeID)]
	return value, exists && value.ProjectID == projectID, nil
}

func (transaction *memoryTransaction) FindDuplicateIntake(_ context.Context, query domainintake.DuplicateQuery) (domainintake.Intake, bool, error) {
	for _, value := range transaction.store.intakes {
		if value.ProjectID == query.ProjectID && value.Type == query.Type && value.Status != domainintake.StatusClosed &&
			equalInt64(value.RequirementID, query.RequirementID) &&
			domainintake.DuplicateEquivalent(value.Title, value.Body, query.Title, query.Body) {
			return value, true, nil
		}
	}
	return domainintake.Intake{}, false, nil
}

func (transaction *memoryTransaction) CreateIntake(ctx context.Context, input domainintake.Create) (domainintake.Intake, error) {
	if input.Type == domainintake.Feedback && input.RequirementID != nil {
		requirement, exists := transaction.store.intakes[intakeKey(domainintake.Requirement, *input.RequirementID)]
		if !exists {
			return domainintake.Intake{}, repository.ErrNotFound
		}
		if requirement.ProjectID != input.ProjectID {
			return domainintake.Intake{}, repository.ErrProjectMismatch
		}
	}
	if _, duplicate, _ := transaction.FindDuplicateIntake(ctx, domainintake.DuplicateQuery{
		ProjectID: input.ProjectID, Type: input.Type, RequirementID: input.RequirementID, Title: input.Title, Body: input.Body,
	}); duplicate {
		return domainintake.Intake{}, repository.ErrDuplicate
	}
	value := domainintake.Intake{
		ID: transaction.store.nextID, ProjectID: input.ProjectID, Type: input.Type,
		RequirementID: copyInt64(input.RequirementID), Title: input.Title, Body: input.Body, Status: input.Status,
		AgentCLI: input.AgentCLI, PlanGeneration: input.PlanGeneration,
		CreatedAt: input.CreatedAt, UpdatedAt: input.UpdatedAt,
	}
	transaction.store.nextID++
	transaction.store.intakes[intakeKey(value.Type, value.ID)] = value
	transaction.wrote = true
	return value, nil
}

func (transaction *memoryTransaction) UpdateIntake(_ context.Context, projectID int64, intakeType domainintake.Type, intakeID int64, update domainintake.Update) (domainintake.Intake, error) {
	current, exists := transaction.store.intakes[intakeKey(intakeType, intakeID)]
	if !exists || current.ProjectID != projectID {
		return domainintake.Intake{}, repository.ErrNotFound
	}
	current.RequirementID, current.Title, current.Body, current.Status = copyInt64(update.RequirementID), update.Title, update.Body, update.Status
	current.AgentCLI, current.PlanGeneration, current.Failure = update.AgentCLI, update.PlanGeneration, update.Failure
	current.AcceptedAt, current.SessionID, current.UpdatedAt = copyString(update.AcceptedAt), copyString(update.SessionID), update.UpdatedAt
	transaction.store.intakes[intakeKey(intakeType, intakeID)] = current
	transaction.wrote = true
	return current, nil
}

func (transaction *memoryTransaction) SetIntakeAcceptance(_ context.Context, projectID int64, intakeType domainintake.Type, intakeID int64, acceptedAt *string, updatedAt string) (domainintake.Intake, error) {
	current, exists := transaction.store.intakes[intakeKey(intakeType, intakeID)]
	if !exists || current.ProjectID != projectID {
		return domainintake.Intake{}, repository.ErrNotFound
	}
	current.AcceptedAt, current.UpdatedAt = copyString(acceptedAt), updatedAt
	transaction.store.intakes[intakeKey(intakeType, intakeID)] = current
	transaction.wrote = true
	return current, nil
}

func (transaction *memoryTransaction) ListPlanLinksForIntake(_ context.Context, projectID int64, intakeType domainintake.Type, intakeID int64) ([]domainintake.PlanLink, error) {
	return append([]domainintake.PlanLink(nil), transaction.store.links[intakeKey(intakeType, intakeID)]...), nil
}
func (transaction *memoryTransaction) ListIntakesForPlan(context.Context, int64, int64) ([]domainintake.IntakeRef, error) {
	return []domainintake.IntakeRef{}, nil
}
func (transaction *memoryTransaction) ReplacePlanLinks(_ context.Context, projectID int64, intakeType domainintake.Type, intakeID int64, inputs []domainintake.PlanLinkInput, updatedAt string) ([]domainintake.PlanLink, error) {
	links := make([]domainintake.PlanLink, len(inputs))
	for index, input := range inputs {
		links[index] = domainintake.PlanLink{
			ID: int64(index + 1), ProjectID: projectID, IntakeType: intakeType, IntakeID: intakeID,
			PlanID: input.PlanID, PhaseIndex: input.PhaseIndex, PhaseTitle: input.PhaseTitle,
			CreatedAt: updatedAt, UpdatedAt: updatedAt,
		}
	}
	sort.SliceStable(links, func(left, right int) bool { return links[left].PhaseIndex < links[right].PhaseIndex })
	transaction.store.links[intakeKey(intakeType, intakeID)] = links
	current := transaction.store.intakes[intakeKey(intakeType, intakeID)]
	current.LinkedPlanID = nil
	if len(links) != 0 {
		current.LinkedPlanID = int64Copy(links[0].PlanID)
	}
	current.UpdatedAt = updatedAt
	transaction.store.intakes[intakeKey(intakeType, intakeID)] = current
	transaction.wrote = true
	return links, nil
}
func (transaction *memoryTransaction) DeletePlanLinksForIntake(_ context.Context, _ int64, intakeType domainintake.Type, intakeID int64, _ string) error {
	delete(transaction.store.links, intakeKey(intakeType, intakeID))
	transaction.wrote = true
	return nil
}
func (transaction *memoryTransaction) DeletePlanAndSyncIntakes(context.Context, int64, int64, string) (domainintake.PlanDeleteResult, error) {
	return domainintake.PlanDeleteResult{}, nil
}
func (transaction *memoryTransaction) DeleteIntake(_ context.Context, projectID int64, intakeType domainintake.Type, intakeID int64, _ string) (domainintake.DeleteResult, error) {
	if transaction.store.deleteError != nil {
		return domainintake.DeleteResult{}, transaction.store.deleteError
	}
	value, exists := transaction.store.intakes[intakeKey(intakeType, intakeID)]
	if !exists || value.ProjectID != projectID {
		return domainintake.DeleteResult{}, repository.ErrNotFound
	}
	delete(transaction.store.intakes, intakeKey(intakeType, intakeID))
	delete(transaction.store.links, intakeKey(intakeType, intakeID))
	transaction.wrote = true
	return domainintake.DeleteResult{Intake: value, AttachmentIDs: []int64{7}}, nil
}
func (transaction *memoryTransaction) AppendIntakeEvent(_ context.Context, event domainintake.PendingEvent) error {
	transaction.store.events = append(transaction.store.events, event)
	transaction.wrote = true
	return nil
}

func (transaction *memoryTransaction) FindIdempotency(_ context.Context, scope, key string) (repository.IdempotencyRecord, bool, error) {
	record, exists := transaction.store.operations[scope+"\x00"+key]
	return record, exists, nil
}
func (transaction *memoryTransaction) ReserveIdempotency(_ context.Context, record repository.IdempotencyRecord) error {
	transaction.store.operations[record.Scope+"\x00"+record.Key] = record
	return nil
}
func (transaction *memoryTransaction) CompleteIdempotency(_ context.Context, scope, key, status string, result, failure *string, updatedAt string) error {
	record := transaction.store.operations[scope+"\x00"+key]
	record.Status, record.ResultJSON, record.ErrorJSON, record.UpdatedAt = status, result, failure, updatedAt
	transaction.store.operations[scope+"\x00"+key] = record
	return nil
}

func intakeKey(intakeType domainintake.Type, id int64) string {
	return string(intakeType) + ":" + formatID(id)
}

func formatID(value int64) string {
	if value == 0 {
		return "0"
	}
	buffer := [20]byte{}
	position := len(buffer)
	for value > 0 {
		position--
		buffer[position] = byte('0' + value%10)
		value /= 10
	}
	return string(buffer[position:])
}

func equalInt64(left, right *int64) bool {
	return (left == nil && right == nil) || (left != nil && right != nil && *left == *right)
}

func int64Copy(value int64) *int64 { return &value }

var _ repository.IntakeTransactional = (*memoryStore)(nil)
var _ repository.IntakeWriteTransaction = (*memoryTransaction)(nil)
