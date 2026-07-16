package modelusage

import (
	"context"

	domainmodelusage "github.com/lyming99/autoplan/backend/internal/domain/modelusage"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

// Recorder is the application boundary for durable provider accounting. The
// repository owns idempotency; callers only need to provide a stable key for
// the provider invocation they just completed.
type Recorder interface {
	Record(context.Context, domainmodelusage.Record) error
}

type Service struct {
	store repository.ModelUsageTransactional
}

func New(store repository.ModelUsageTransactional) *Service {
	return &Service{store: store}
}

func (service *Service) Record(ctx context.Context, value domainmodelusage.Record) error {
	if service == nil || service.store == nil {
		return repository.ErrNotConfigured
	}
	return service.store.TransactModelUsage(ctx, func(transaction repository.ModelUsageWriteTransaction) error {
		_, err := transaction.RecordModelUsage(ctx, value)
		return err
	})
}

var _ Recorder = (*Service)(nil)
