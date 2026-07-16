package chat

import (
	"context"
	"testing"

	domainchat "github.com/lyming99/autoplan/backend/internal/domain/chat"
	domainmodelusage "github.com/lyming99/autoplan/backend/internal/domain/modelusage"
)

type chatUsageRecorder struct {
	records []domainmodelusage.Record
	ctxErr  error
}

func (recorder *chatUsageRecorder) Record(ctx context.Context, value domainmodelusage.Record) error {
	recorder.ctxErr = ctx.Err()
	recorder.records = append(recorder.records, value)
	return nil
}

func TestProviderDigestBindsTurnAndPrompt(t *testing.T) {
	command := ProviderCommand{
		ProjectID: 1, ConversationID: 2, Prompt: "first", RequestID: "request-1",
		Profile: domainchat.ProviderProfile{Kind: domainchat.ProviderCodexCLI, Model: "model"},
	}
	claim := TurnClaim{TurnID: "chat-turn-9"}
	first := providerDigest(command, claim)
	command.Prompt = "second"
	if first == providerDigest(command, claim) || len(first) != 64 {
		t.Fatal("provider digest did not bind the durable turn intent")
	}
}

func TestChunkCollectorRejectsSplitSensitiveOutput(t *testing.T) {
	collector := &ChunkCollector{}
	if _, err := collector.Push(domainchat.ProviderChunk{Kind: domainchat.ChunkText, Text: "prefix to"}); err != nil {
		t.Fatal(err)
	}
	if _, err := collector.Push(domainchat.ProviderChunk{Kind: domainchat.ChunkText, Text: "ken=secret"}); err == nil {
		t.Fatal("split sensitive output was accepted")
	}
}

func TestParseOpenAIChunkPreservesTextOnly(t *testing.T) {
	chunks, err := parseOpenAIJSON([]byte(`{"choices":[{"delta":{"content":"safe text"}}]}`))
	if err != nil || len(chunks) != 1 || chunks[0].Kind != domainchat.ChunkText || chunks[0].Text != "safe text" {
		t.Fatalf("chunks=%#v error=%v", chunks, err)
	}
}

func TestProviderCompletionRecordsChatUsageWithConversationOperation(t *testing.T) {
	recorder := &chatUsageRecorder{}
	service := NewProviderService(ProviderDependencies{Usage: recorder})
	input, output, total := int64(12), int64(5), int64(17)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := service.recordUsage(ctx, ProviderCommand{
		ProjectID: 7, ConversationID: 11,
		Profile: domainchat.ProviderProfile{Kind: domainchat.ProviderOpenAI, Model: "gpt-fixture"},
	}, TurnClaim{MessageID: 13, TurnID: "chat-turn-13"}, "chat-operation-1", &domainmodelusage.Tokens{
		Input: &input, Output: &output, Total: &total,
	})
	if err != nil || len(recorder.records) != 1 || recorder.ctxErr != nil {
		t.Fatalf("records=%#v ctxErr=%v err=%v", recorder.records, recorder.ctxErr, err)
	}
	record := recorder.records[0]
	if record.Source != domainmodelusage.SourceChat || record.ProjectID != 7 || record.Provider != "openai" ||
		record.Model != "gpt-fixture" || record.OperationID == nil || *record.OperationID != "chat-operation-1" ||
		record.InvocationKey != "chat:chat-operation-1:conversation:11:turn:13" {
		t.Fatalf("record=%#v", record)
	}
}
