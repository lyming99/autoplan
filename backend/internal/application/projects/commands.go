package projects

import (
	"context"
	"strings"

	applicationconfig "github.com/lyming99/autoplan/backend/internal/application/config"
	applicationidempotency "github.com/lyming99/autoplan/backend/internal/application/idempotency"
	domainconfig "github.com/lyming99/autoplan/backend/internal/domain/config"
	"github.com/lyming99/autoplan/backend/internal/domain/contracts"
	domainproject "github.com/lyming99/autoplan/backend/internal/domain/project"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

const (
	RouteCreate = "projects:create"
	RouteUpdate = "projects:update"
	RouteDelete = "projects:delete"
)

type MutationMetadata struct {
	CallerScope    string
	IdempotencyKey string
	RequestID      string
}

type CreateCommand struct {
	Project  domainproject.Create
	Config   *domainconfig.LoopConfig
	Settings []repository.SettingMutation
	Metadata MutationMetadata
}

type UpdateCommand struct {
	ProjectID            int64
	Project              domainproject.Update
	Config               *domainconfig.LoopConfig
	ExpectedStateVersion int64
	Settings             []repository.SettingMutation
	Metadata             MutationMetadata
}

type DeleteCommand struct {
	ProjectID int64
	Metadata  MutationMetadata
}

func (service *Service) Create(
	ctx context.Context,
	command CreateCommand,
	visibility domainproject.Visibility,
) (contracts.AppSnapshot, error) {
	if err := service.readyMutation(ctx); err != nil {
		return contracts.AppSnapshot{}, err
	}
	occurredAt := service.timestamp()
	projectInput := domainproject.NormalizeCreate(command.Project)
	settings, err := applicationconfig.NormalizeSettings(command.Settings)
	if err != nil {
		return contracts.AppSnapshot{}, err
	}
	config, err := normalizeOptionalConfig(command.Config)
	if err != nil {
		return contracts.AppSnapshot{}, err
	}
	prepared, err := service.idempotency.Prepare(applicationidempotency.Request{
		Scope: command.Metadata.CallerScope, Key: command.Metadata.IdempotencyKey,
		RequestID: command.Metadata.RequestID, Route: RouteCreate,
		Payload: struct {
			Project  domainproject.Create
			Config   *domainconfig.LoopConfig
			Settings []repository.SettingMutation
		}{projectInput, config, settings}, OccurredAt: occurredAt,
	})
	if err != nil {
		return contracts.AppSnapshot{}, err
	}
	var reference applicationidempotency.Reference
	err = service.writer.Transact(ctx, func(transaction repository.WriteTransaction) error {
		decision, beginErr := service.idempotency.Begin(ctx, transaction, prepared)
		if beginErr != nil {
			return beginErr
		}
		if decision.Replay {
			reference = decision.Reference
			return nil
		}
		project, state, createErr := transaction.CreateProject(ctx, projectInput, occurredAt)
		if createErr != nil {
			return createErr
		}
		if config != nil {
			if _, _, configErr := transaction.PutLoopConfig(ctx, project.ID, state.Version, *config, occurredAt); configErr != nil {
				return configErr
			}
		}
		if settingsErr := putSettings(ctx, transaction, settings); settingsErr != nil {
			return settingsErr
		}
		projectID := project.ID
		reference = applicationidempotency.Reference{Kind: "active-project", ProjectID: &projectID}
		return service.idempotency.Complete(ctx, transaction, prepared, reference, occurredAt)
	})
	if err != nil {
		return contracts.AppSnapshot{}, err
	}
	return service.snapshotReference(ctx, reference, visibility)
}

func (service *Service) Update(
	ctx context.Context,
	command UpdateCommand,
	visibility domainproject.Visibility,
) (contracts.AppSnapshot, error) {
	if err := service.readyMutation(ctx); err != nil {
		return contracts.AppSnapshot{}, err
	}
	projectID := command.ProjectID
	occurredAt := service.timestamp()
	projectUpdate := normalizeProjectUpdate(command.Project)
	settings, err := applicationconfig.NormalizeSettings(command.Settings)
	if err != nil {
		return contracts.AppSnapshot{}, err
	}
	config, err := normalizeOptionalConfig(command.Config)
	if err != nil {
		return contracts.AppSnapshot{}, err
	}
	prepared, err := service.idempotency.Prepare(applicationidempotency.Request{
		Scope: command.Metadata.CallerScope, Key: command.Metadata.IdempotencyKey,
		RequestID: command.Metadata.RequestID, Route: RouteUpdate, ProjectID: &projectID,
		Payload: struct {
			Project              domainproject.Update
			Config               *domainconfig.LoopConfig
			ExpectedStateVersion int64
			Settings             []repository.SettingMutation
		}{projectUpdate, config, command.ExpectedStateVersion, settings}, OccurredAt: occurredAt,
	})
	if err != nil {
		return contracts.AppSnapshot{}, err
	}
	var reference applicationidempotency.Reference
	err = service.writer.Transact(ctx, func(transaction repository.WriteTransaction) error {
		decision, beginErr := service.idempotency.Begin(ctx, transaction, prepared)
		if beginErr != nil {
			return beginErr
		}
		if decision.Replay {
			reference = decision.Reference
			return nil
		}
		if config != nil {
			if _, _, configErr := transaction.PutLoopConfig(ctx, projectID, command.ExpectedStateVersion, *config, occurredAt); configErr != nil {
				return configErr
			}
		}
		if settingsErr := putSettings(ctx, transaction, settings); settingsErr != nil {
			return settingsErr
		}
		if _, updateErr := transaction.UpdateProject(ctx, projectID, projectUpdate, occurredAt); updateErr != nil {
			return updateErr
		}
		reference = applicationidempotency.Reference{Kind: "active-project", ProjectID: &projectID}
		return service.idempotency.Complete(ctx, transaction, prepared, reference, occurredAt)
	})
	if err != nil {
		return contracts.AppSnapshot{}, err
	}
	return service.snapshotReference(ctx, reference, visibility)
}

func (service *Service) Delete(
	ctx context.Context,
	command DeleteCommand,
	visibility domainproject.Visibility,
) (contracts.AppSnapshot, error) {
	if err := service.readyMutation(ctx); err != nil {
		return contracts.AppSnapshot{}, err
	}
	projectID := command.ProjectID
	occurredAt := service.timestamp()
	prepared, err := service.idempotency.Prepare(applicationidempotency.Request{
		Scope: command.Metadata.CallerScope, Key: command.Metadata.IdempotencyKey,
		// The delete intent is global to the caller/key and must survive removal
		// of the aggregate it targets. Keeping this operation project-scoped
		// creates an immediate FK blocker and makes every delete fail.
		RequestID: command.Metadata.RequestID, Route: RouteDelete, ProjectID: nil,
		Payload: struct{ ProjectID int64 }{projectID}, OccurredAt: occurredAt,
	})
	if err != nil {
		return contracts.AppSnapshot{}, err
	}
	reference := applicationidempotency.Reference{Kind: "project-list"}
	err = service.writer.Transact(ctx, func(transaction repository.WriteTransaction) error {
		decision, beginErr := service.idempotency.Begin(ctx, transaction, prepared)
		if beginErr != nil {
			return beginErr
		}
		if decision.Replay {
			reference = decision.Reference
			return nil
		}
		if deleteErr := transaction.DeleteProject(ctx, projectID); deleteErr != nil {
			return deleteErr
		}
		return service.idempotency.Complete(ctx, transaction, prepared, reference, occurredAt)
	})
	if err != nil {
		return contracts.AppSnapshot{}, err
	}
	return service.snapshotReference(ctx, reference, visibility)
}

func putSettings(ctx context.Context, transaction repository.WriteTransaction, settings []repository.SettingMutation) error {
	for _, setting := range settings {
		if _, _, err := transaction.PutSetting(ctx, setting); err != nil {
			return err
		}
	}
	return nil
}

func normalizeOptionalConfig(value *domainconfig.LoopConfig) (*domainconfig.LoopConfig, error) {
	if value == nil {
		return nil, nil
	}
	normalized, err := domainconfig.NormalizeLoopConfig(*value)
	if err != nil {
		return nil, err
	}
	return &normalized, nil
}

func normalizeProjectUpdate(value domainproject.Update) domainproject.Update {
	if value.Name != nil {
		name := strings.TrimSpace(*value.Name)
		if name == "" {
			value.Name = nil
		} else {
			value.Name = &name
		}
	}
	return value
}

func (service *Service) snapshotReference(
	ctx context.Context,
	reference applicationidempotency.Reference,
	visibility domainproject.Visibility,
) (contracts.AppSnapshot, error) {
	switch reference.Kind {
	case "active-project":
		if reference.ProjectID == nil {
			return contracts.AppSnapshot{}, repository.ErrTransaction
		}
		return service.assembler.Assemble(ctx, reference.ProjectID, visibility)
	case "project-list":
		return service.assembler.Assemble(ctx, nil, visibility)
	default:
		return contracts.AppSnapshot{}, repository.ErrTransaction
	}
}
