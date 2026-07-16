package plans

import (
	"context"

	"github.com/lyming99/autoplan/backend/internal/domain/contracts"
	domainplan "github.com/lyming99/autoplan/backend/internal/domain/plan"
	domainproject "github.com/lyming99/autoplan/backend/internal/domain/project"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

type ListQuery struct {
	ProjectID int64
	Limit     int
	Offset    int
}

func (service *Service) List(ctx context.Context, query ListQuery) ([]PlanDTO, error) {
	if err := service.ready(ctx); err != nil {
		return nil, err
	}
	if query.ProjectID <= 0 || query.Offset < 0 {
		return nil, ErrInvalidCommand
	}
	query.Limit = boundedLimit(query.Limit, 100)
	var records []domainplan.Plan
	var workspace string
	err := service.writer.TransactPlans(ctx, func(transaction repository.PlanWriteTransaction) error {
		project, found, err := transaction.GetProject(ctx, query.ProjectID)
		if err != nil {
			return err
		}
		if !found {
			return repository.ErrNotFound
		}
		workspace = project.WorkspacePath
		records, err = transaction.ListPlans(ctx, domainplan.ListOptions{
			ProjectID: query.ProjectID, Limit: query.Limit, Offset: query.Offset,
		})
		return err
	})
	if err != nil {
		return nil, err
	}
	result := make([]PlanDTO, 0, len(records))
	for _, record := range records {
		result = append(result, planDTO(record, ResolvePlanTitle(workspace, record)))
	}
	return result, nil
}

func (service *Service) Get(ctx context.Context, projectID, planID int64) (PlanDTO, error) {
	if err := service.ready(ctx); err != nil {
		return PlanDTO{}, err
	}
	if projectID <= 0 || planID <= 0 {
		return PlanDTO{}, ErrInvalidCommand
	}
	var record domainplan.Plan
	var workspace string
	err := service.writer.TransactPlans(ctx, func(transaction repository.PlanWriteTransaction) error {
		project, found, err := transaction.GetProject(ctx, projectID)
		if err != nil {
			return err
		}
		if !found {
			return repository.ErrNotFound
		}
		workspace = project.WorkspacePath
		record, found, err = transaction.GetPlan(ctx, projectID, planID)
		if err != nil {
			return err
		}
		if !found {
			return repository.ErrNotFound
		}
		return nil
	})
	if err != nil {
		return PlanDTO{}, err
	}
	return planDTO(record, ResolvePlanTitle(workspace, record)), nil
}

func (service *Service) ListTasks(ctx context.Context, projectID, planID int64) ([]TaskDTO, error) {
	if err := service.ready(ctx); err != nil {
		return nil, err
	}
	if projectID <= 0 || planID <= 0 {
		return nil, ErrInvalidCommand
	}
	var parent domainplan.Plan
	var records []domainplan.Task
	var workspace string
	err := service.writer.TransactPlans(ctx, func(transaction repository.PlanWriteTransaction) error {
		project, found, err := transaction.GetProject(ctx, projectID)
		if err != nil {
			return err
		}
		if !found {
			return repository.ErrNotFound
		}
		workspace = project.WorkspacePath
		parent, found, err = transaction.GetPlan(ctx, projectID, planID)
		if err != nil {
			return err
		}
		if !found {
			return repository.ErrNotFound
		}
		records, err = transaction.ListPlanTasks(ctx, projectID, planID)
		return err
	})
	if err != nil {
		return nil, err
	}
	parentDTO := planDTO(parent, ResolvePlanTitle(workspace, parent))
	result := make([]TaskDTO, 0, len(records))
	for _, record := range records {
		result = append(result, taskDTO(record, parentDTO))
	}
	return result, nil
}

func (service *Service) GetTask(ctx context.Context, projectID, planID, taskID int64) (TaskDTO, error) {
	if err := service.ready(ctx); err != nil {
		return TaskDTO{}, err
	}
	if projectID <= 0 || planID <= 0 || taskID <= 0 {
		return TaskDTO{}, ErrInvalidCommand
	}
	var parent domainplan.Plan
	var record domainplan.Task
	var workspace string
	err := service.writer.TransactPlans(ctx, func(transaction repository.PlanWriteTransaction) error {
		project, found, err := transaction.GetProject(ctx, projectID)
		if err != nil {
			return err
		}
		if !found {
			return repository.ErrNotFound
		}
		workspace = project.WorkspacePath
		parent, found, err = transaction.GetPlan(ctx, projectID, planID)
		if err != nil {
			return err
		}
		if !found {
			return repository.ErrNotFound
		}
		record, found, err = transaction.GetPlanTask(ctx, projectID, planID, taskID)
		if err != nil {
			return err
		}
		if !found {
			return repository.ErrNotFound
		}
		return nil
	})
	if err != nil {
		return TaskDTO{}, err
	}
	parentDTO := planDTO(parent, ResolvePlanTitle(workspace, parent))
	return taskDTO(record, parentDTO), nil
}

func (service *Service) Snapshot(
	ctx context.Context,
	projectID int64,
	visibility domainproject.Visibility,
) (contracts.AppSnapshot, error) {
	if err := service.ready(ctx); err != nil {
		return contracts.AppSnapshot{}, err
	}
	return service.snapshot(ctx, projectID, visibility)
}

func boundedLimit(value, fallback int) int {
	if value <= 0 {
		return fallback
	}
	if value > 200 {
		return 200
	}
	return value
}
