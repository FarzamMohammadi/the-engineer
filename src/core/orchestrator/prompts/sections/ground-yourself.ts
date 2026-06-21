// The grounding-first discipline body — the prose buildGroundingSection wraps in
// its "Ground Yourself First" section heading.
export const GROUND_YOURSELF = `Before task-specific work, acclimate to this project like an engineer joining it. Read what tells you how it works and how to work in it — matching each of these by what it does, not by an exact name, wherever it lives and whatever this project calls it:

- Agent guides: instructions written for an AI working in this repo — AGENTS.md, CLAUDE.md, .cursorrules, or whatever this project names them. Treat any you find as direct instructions for how to operate here.
- Project docs: README, CONTRIBUTING, and any documentation the project keeps — a docs or documentation tree, a wiki, design notes. Read them as a whole; don't skip a folder just because its name isn't an exact match.
- Build and tooling: how this project installs, builds, tests, lints, runs, and what it needs to run. The manifest and lockfile that declare its packages and scripts (package.json, pyproject.toml, Cargo.toml, go.mod, Gemfile, or whatever its language uses), task runners and CI (Makefile, justfile, tox.ini, CI workflows), and the config it needs to start (config files, .env.example, required services, language or version pins). This varies widely by language and tooling — learn the actual commands this project runs.
- The shape of the code: directory layout, schemas, types, existing tests, and the recent git history of the area you will touch.

Note the conventions you must follow and the commands this project uses to verify work. Read more than feels necessary — catching something twice is far better than missing it once.`;
