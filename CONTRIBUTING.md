# Contributing to ARENA Persist

The general Contribution Guide for all ARENA projects can be found [here](https://docs.arenaxr.org/content/contributing.html).

This document covers **development rules and conventions** specific to this repository. These rules are mandatory for all contributors, including automated/agentic coding tools.

## Development Rules

### 1. MQTT Topics — Always Use the `TOPICS` Constructor

**Never hardcode MQTT topic strings.** All topic paths must be constructed using the local `TOPICS` string constructor for ease of future topics modulation. This enables future topic format refactoring without scattered string updates.

### 2. Dependencies — Pin All Versions

**All dependencies must use exact, pegged versions** (no `^`, `~`, or `*` ranges). This prevents version drift across environments and ensures reproducible builds for security.

## Local Development

To develop the `arena-persist` locally:
1. Run `init-config.sh` in the parent `arena-services-docker` directory to generate the required `.env` secrets and configuration files.
2. Start the local stack using `docker-compose -f docker-compose.localdev.yaml up -d arena-persist`
3. The Node.js source folder is mounted via the localdev compose file. Modifying the `.js` files will automatically restart the server via `nodemon`.

## Testing

The unit tests in `test/` run **offline** with Node's built-in test runner — no MongoDB, no MQTT broker, and none of the `arena-services-docker` `.env` configuration above are required.

1. Install dependencies: `npm ci`
2. Run the full suite, exactly as CI does: `npm test`

While iterating, narrow the run (`npm test` is `node --test`):

```bash
node --test test/utils.test.js                                # one file
node --test --test-name-pattern='flatten' test/utils.test.js  # one suite or test, by name
```

> [!CAUTION]
> Do not skip `npm ci` — `npm test` will still run, but files with unmet `require`s never load, so you get a silently truncated suite and a handful of failures that look unrelated to your change.

New test files must match the runner's default pattern (`*.test.js`) or they are never discovered, and the suite stays green without them.

## Code Style
- Follow standard JavaScript formatting guidelines.
- Use explicit async/await constructs for all asynchronous MQTT and MongoDB operations.
- **ESLint is configured but not gated.** `.eslintrc.js` (`eslint-config-google`, 4-space indent, 120-column limit) is not run by CI and there is no `npm run lint` script, but style is still raised in review. Check your own changes with `npx eslint <file>`. Note that `npx eslint .` reports 3 pre-existing errors in `server.js` and `topics.js` on `master` — leave those alone.

The `arena-persist` uses [Release Please](https://github.com/googleapis/release-please) to automate CHANGELOG generation and semantic versioning. Your PR titles *must* follow Conventional Commit standards (e.g., `feat:`, `fix:`, `chore:`).

> [!CAUTION]
> **Never use `BREAKING CHANGE` in commit/PR bodies or the `!` suffix on commit/PR types (e.g., `feat!:`, `fix!:`).** These tokens cause release-please to automatically bump the major version. Major version increments are reserved for the maintainer's explicit decision — contributors and agents do not decide what constitutes a breaking change for semver purposes.

> [!IMPORTANT]
> **Issue and PR References in Commit & PR Messages:**
> Only use `#NN` notation in commit messages, PR titles, and PR descriptions if they correspond to actual GitHub issues or pull requests. Do **not** use `#NN` notation for internal enumerations of planning docs or triage items (e.g., use `Task NN` or plain text instead), as this creates erroneous links and may result in unintended automatic actions.


## CI & Dependency Management Conventions
- **GitHub Actions Tag SHA Pinning**: All GitHub Action references in `.github/workflows/` MUST be pinned to the exact commit SHA of the official release tag (e.g., `uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0`).
- **Inline Version Comments**: The inline comment next to the SHA MUST specify the exact tag version used. This enables Dependabot to recognize the release version, generate human-readable SemVer PR titles (`from X.Y.Z to A.B.C`), and automatically update version comments during upgrades.