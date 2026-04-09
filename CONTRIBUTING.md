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

## Code Style
- Follow standard JavaScript formatting guidelines.
- Use explicit async/await constructs for all asynchronous MQTT and MongoDB operations.

The `arena-persist` uses [Release Please](https://github.com/googleapis/release-please) to automate CHANGELOG generation and semantic versioning. Your PR titles *must* follow Conventional Commit standards (e.g., `feat:`, `fix:`, `chore:`).
