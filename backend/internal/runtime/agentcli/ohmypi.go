package agentcli

import "context"

type ohMyPiAdapter struct{}

func (ohMyPiAdapter) Provider() Provider { return ProviderOhMyPi }

func (ohMyPiAdapter) Prepare(_ context.Context, request Request, _ ArtifactWriter) (Prepared, error) {
	command, err := resolvedCommand(ProviderOhMyPi, request.Command)
	if err != nil {
		return Prepared{}, err
	}
	return Prepared{
		Executable: command, Arguments: []string{"--mode", "json"}, PromptMode: PromptStdin, Prompt: request.Prompt,
		Parser: ParserOhMyPi,
	}, nil
}
