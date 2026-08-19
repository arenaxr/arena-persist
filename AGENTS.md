# Agent Guide

Orientation for agents (and humans) working in this repo. Detailed docs live in the files below — this file is just the index.

## Start here
- [README.md](README.md) — what arena-persist is: a Node.js persistence service that listens on MQTT for ARENA objects and saves them to MongoDB.
- [REQUIREMENTS.md](REQUIREMENTS.md) — machine- and human-readable reference for features, architecture, and source layout.

## Conventions & development rules
- [CONTRIBUTING.md](CONTRIBUTING.md) — mandatory rules for all contributors, **including agents**: MQTT topic construction, development rules.

## Testing
- [test/](test/) — unit tests for the MQTT handlers, cascade logic, express routes, topics, and utils. Run by Node's built-in test runner and gated by the `Unit Tests` workflow ([.github/workflows/test.yml](.github/workflows/test.yml)).
- Before committing: `npm ci` then `npm test`. Narrow with `node --test test/utils.test.js` or `node --test --test-name-pattern='<name>' test/utils.test.js`. The tests are offline — no MongoDB or MQTT broker needed, and none of the `arena-services-docker` local-stack setup.
- [CONTRIBUTING.md](CONTRIBUTING.md) — the **Testing** section covers the above plus the un-gated ESLint check (`npx eslint <file>`; `master` has 3 pre-existing errors).

## Release history
- [CHANGELOG.md](CHANGELOG.md) — generated release history (release-please; Conventional Commits).
