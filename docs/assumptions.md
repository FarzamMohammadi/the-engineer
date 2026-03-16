# Assumptions

## LLM Provider Authentication

Users authenticate with their LLM CLI provider (e.g., `claude` CLI) in a separate terminal session before starting The Engineer. The Engineer does not forward authentication credentials (API keys, tokens) to spawned LLM subprocesses — it relies on the provider's own session/keychain authentication being available system-wide.
