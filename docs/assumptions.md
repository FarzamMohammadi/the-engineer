# Assumptions

## Agent Provider Authentication

Users authenticate with their agent CLI provider (e.g., `claude` CLI) in a separate terminal session before starting The Engineer. The Engineer does not forward authentication credentials (API keys, tokens) to spawned agent subprocesses — it relies on the provider's own session/keychain authentication being available system-wide.
