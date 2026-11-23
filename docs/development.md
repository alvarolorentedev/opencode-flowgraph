# Development

## Architecture and ownership

- OpenCode owns agents, sessions, permissions, models, and tools.
- The plugin owns workflow YAML parsing, graph validation, orchestration, run state, recovery, and Mermaid generation.
- Workflow definitions live in `.flowgraph/workflows` (legacy `.opencode/workflows` is read when the neutral directory is absent). See [workflow directory resolution](architecture.md#workflow-directory).
- OpenCode runtime state stays in OpenCode plugin storage, keyed by project.
- The standalone CLI keeps its state in `.flowgraph/state`.

### Modules

| Module | Responsibility |
|---|---|
| `workflow/schema.ts` | Zod YAML schema, hard limits, and `NodeResultJsonSchema` generated from `NodeResultSchema` |
| `workflow/loader.ts` | Safe YAML parsing, discovery, hashing, atomic file operations |
| `workflow/root.ts` | Shared explicit/neutral/legacy workflow-directory resolver |
| `workflow/graph.ts` | Pure graph construction, validation, transition resolution |
| `workflow/mermaid.ts` | Pure, escaped, deterministic Mermaid generation |
| `workflow/validator.ts` | Structural validation, semantic validation, adapter agent resolution |
| `execution/harness.ts` | Portable `HarnessAdapter` contract and strict `HarnessCapabilitiesSchema` |
| `execution/report-intake.ts` | Structured-result validation, attribution, canonical persistence, dedupe, and `syntheticReportRef` |
| `adapters/opencode/runtime.ts` | OpenCode `HarnessAdapter` over native agents, sessions, and permissions |
| `adapters/opencode/report-tool.ts` | OpenCode `flowgraph_report` tool |
| `adapters/opencode/tool-hooks.ts` | Workflow-session background-work policy and protected configuration guard |
| `adapters/opencode/results.ts` | OpenCode usage/audit normalization |
| `execution/prompts.ts` | Bounded context handoff prompts with adapter-supplied completion text |
| `execution/results.ts` | Portable usage merge and outcome assertion |
| `execution/run-graph.ts` | Structured run graph, active-node state, session mapping, ownership-aware controls |
| `ui/runs.ts` | Cross-project/worktree run discovery, merge, and ordering |
| `ui/harness.ts` | Pure active-harness lines, warnings, and foreign-run copy |
| `ui/graph.ts` | Pure boxed terminal diagram: ranking, rails, tones, width/height fallback |
| `tui.tsx` | TUI workflow page, session panel, command, keyboard controls |
| `gui.tsx` | Experimental Desktop GUI run picker, panel, and Mermaid renderer |
| `execution/runner.ts` | Concurrent session scheduler, controls, limits, and recovery |
| `execution/checkpoint.ts` | Durable branch, call, and join transitions |
| `state/store.ts` | Project-scoped records, revisioned mutations, and harness sidecar |
| `state/concurrency.ts` | Host-local run ownership lock |
| `storage/filesystem.ts` | Durable key/value `StoragePort` for the CLI |
| `runtime/create.ts` | Harness-independent runtime factory, recovery, and shutdown |
| `service.ts` | Workflow discovery/validation and run control facade |
| `contract.ts` | Shared Zod schemas and exported types |
| `core.ts` | Portable public schema/loader/validator/harness exports |
| `cli.ts` | Standalone `flowgraph` CLI |
| `adapters/opencode/rpc/` | OpenCode `Rpc.define` contract, handlers, and error mapping |
| `rpc.ts` | Public re-export of the OpenCode RPC contract |
| `index.ts` | Thin OpenCode plugin composition root |

### Structured result boundary

Agent prompts do not have a universal native response schema. The core owns `ReportIntake`, which validates outcomes, attributes reports to the active run/step/session, and persists one canonical report per step. The first valid report wins; an identical resubmission is idempotent, and a conflict or a second reference is rejected without replacing it. The store serializes that check per step on one server. Each adapter transports the report using its native mechanism: a typed tool, native structured output, or a client-provided MCP tool.

For native structured output, use `NodeResultJsonSchema`; it is generated from `NodeResultSchema` and pinned by `test/execution/result-schema.test.ts`. A transport without a native tool-call ID passes `syntheticReportRef(runID, stepID, sessionID, attempt)` as the report reference.

Free-form phrases such as `DONE` or `LGTM` are never parsed. The graph, not the agent, chooses the next node.

## Local development

```sh
bun install
bun run typecheck
bun run test
bun run build:portable
bun run build:cli
node dist/cli.js --help
```

`bun run test` runs `pretest`, which builds the portable entries and the CLI
first. That keeps the built-artifact architecture assertion and
`test/cli/built.test.ts` meaningful in CI and on a fresh clone. `bun run check`
runs typecheck plus the full unit suite. `bun run build` produces `dist/core.js`,
`dist/runtime.js`, `dist/storage.js`, `dist/cli.js`, and the experimental GUI
bundle. `prepublishOnly` runs `check` and `build`. `bun pm pack --dry-run` (or
`npm pack --dry-run` with npm 11.5.1+) must list the CLI, portable bundles, and
the existing OpenCode plugin files.

The CLI smoke path needs no OpenCode binary:

```sh
node dist/cli.js --project . list
node dist/cli.js --project . validate development
node dist/cli.js --project . runs
```

`run`, `pause`, `resume`, `cancel`, and `respond` need
`--adapter-module <local-module>` exporting `createHarnessAdapter(context)`.
Adapter modules are trusted local code; the CLI never downloads them. Unit
tests use a temporary self-contained module and a hanging fixture to exercise
foreground execution and graceful interruption.

The optional real OpenCode plugin-loading/RPC smoke test:

```sh
OPENCODE_SMOKE=1 OPENCODE_BIN=/path/to/opencode bun run test:smoke
```

It starts an isolated `opencode serve`, loads the plugin from this repository, and calls `capabilities`, `listWorkflows`, and the workflow CRUD methods. It also covers a no-model human-only lifecycle: start, human decision, a second approval through to `completed`, pause, resume, and a separate run that is cancelled at its blocker. It does not make model calls.

The opt-in model-routing integration uses a local OpenAI-compatible mock server and makes no paid model calls:

```sh
OPENCODE_MODEL_INTEGRATION=1 OPENCODE_BIN=/path/to/opencode bun run test:integration
```

It checks the model IDs and variant sent in actual inference requests, and restarts `opencode serve` mid-agent-step twice: with a persisted `flowgraph_report`, recovery reconciles the report and completes the run; without a report, recovery blocks or fails conservatively. Neither path re-sends the prompt. The mock provider cannot deterministically produce an unknown prompt admission or an unknown permission state, so those recovery cases are covered only by the `FakeHarness` contract suite. The default unit suite still uses `FakeHarness` and does not require an OpenCode binary.

**Verification record (2026-11-22, PO scope execution):** `bun run check` → typecheck plus the full unit suite: 27 files passed, 252 passed, 5 skipped (2 files: the OpenCode smoke and model-integration suites). `bun run build:gui` → pass. `bun run build:portable` → `dist/core.js`, `dist/runtime.js`, `dist/storage.js`. `bun run build:cli` → `dist/cli.js`; `node dist/cli.js --help` and `node dist/cli.js --version` → pass; the built CLI carries the `#!/usr/bin/env node` shebang and the architecture tests pin that it has no `@opencode/*` imports. CLI smoke on the built artifact: temp project `list` → exit 0; `run` without `--adapter-module` → exit 3 with a clear message; foreground run with a fixture adapter module → the run ID is printed immediately and the run completes with exit 0, inspectable via `runs`/`graph`; SIGINT during a hanging run → exit 130. `bun pm pack --dry-run` → `dist/cli.js`, `dist/core.js`, `dist/runtime.js`, `dist/storage.js`, and the GUI bundle are packed, and the packaged `package.json` keeps the `./core`, `./runtime`, `./storage` exports, the `flowgraph` bin, and marks the OpenCode/TUI peers optional; `npm` is not installed in this shell, so `bun pm pack --dry-run` (and one real pack to inspect the tarball) was used instead. The manual real-model E2E run and the manual TUI/Desktop check remain outstanding. Durable-report reconciliation after restart is also covered at the core level by `test/execution/runner.test.ts` ("recovers a node that completed before the run checkpoint").

**Portable runtime/CLI verification (2026-11-22):** `bun run check` → typecheck plus `pretest` builds and the full unit suite: 28 files passed, 279 passed, 5 skipped (30 files; the two opt-in integration suites remain skipped). `bun run build:gui` → pass (Node 18.19.1 below Vite's recommendation). The built CLI reports `1.0.1` for `--version`, lists and validates this repository's legacy workflows, runs a stored workflow through a temporary adapter module in a temp project, and lists/inspects the resulting CLI state. Manual built-artifact checks: `.flowgraph` and `.flowgraph/state` symlinks plus a `--state-dir` symlink outside the project exit `2` and write nothing outside; `--state-dir .` is rejected; explicit and neutral workflow roots that are symlinks outside exit `2`; `runs | head -1` exits `0` with no stack; a CLI-owned run's graph prints `Harness: smoke`, not `read-only`. `bun pm pack --dry-run` lists `dist/cli.js`, `dist/core.js`, `dist/runtime.js`, `dist/storage.js`, and the existing OpenCode plugin files. The opt-in OpenCode smoke/model suites were not re-run for this change; no OpenCode runtime or model behavior changed.

Follow-up regression coverage: structural `list`/`validate` now walk referenced workflows (missing child and recursive calls are file errors, not agent resolution); `pause` starts the drain loop for a run restored after a process exit and the CLI refuses a run with any branch blocked on a native permission or human decision, including a fork; a permission that appears only after the drain starts stops the wait with exit `1` and leaves the run `pausing`; a pause drain never consumes `max_recovery_attempts`, so four interrupted pauses stay resumable; blocker hints include the adapter module and distinguish respond, resume, and `--confirm-retry`, and print every applicable hint for a fork; validation diagnostics print on a failed `run`; `.flowgraph` is a protected path and `.flowgraph/state` is git-ignored; runtime auto-recovery has tests for a persisted running run and for shutdown before the recovery timer. Filesystem scans reject a record whose key no longer matches its hashed file name, and read-only commands terminate on SIGINT/SIGTERM even while an adapter module is loading.

**OpenCode 2.3.2 gate:** `@opencode/cli` 2.3.2 now loads plugins lazily, so the request that triggers loading can lose the race and return either `rpc.unavailable` or a `503` with `{"code":"service_starting"}`; a retry within the 20-second deadline succeeds. Both opt-in suites retry both transient responses and ignore OpenCode's parent-session subagent-completion turn. Where native agents must be registered, they wait for workflow validity first: the smoke suite waits for `sample` before asserting it, and all three model-suite `startRun` calls wait for their workflow. The smoke lifecycle is human-only, so its runs need no agent wait. With those readiness waits, `OPENCODE_SMOKE=1 ...` → 2 passed and `OPENCODE_MODEL_INTEGRATION=1 ...` → 3 passed on 2.3.2. The waits do not skip or weaken assertions.

The adapter contract suite is reusable. `test/contract/harness-suite.ts` exports `describeHarnessContract`; a new adapter supplies a fixture factory and runs it without touching the core tests. `test/contract/harness-contract.test.ts` runs it on two `FakeHarness` capability variants, including a parentless-session variant, and includes capability-honesty and unknown-terminal recovery checks.

A real-model end-to-end verification is manual: define two primary agents, create the workflow, start a run through RPC, verify the review loop, disconnect the client, restart the server, and confirm conservative recovery. See [`operations.md`](operations.md) and [`interfaces.md`](interfaces.md).

A local plugin entry needs a root `index.ts` (server) and `rpc.ts` (shared contract); this repository provides both.

### Development workflows

The project's `.opencode/agents` and `.opencode/workflows` run flowgraph on
itself. The workflows stay in the legacy directory for this repository, so the
plugin logs the one legacy-directory warning. `opencode.jsonc` declares the
published plugin, so OpenCode installs it when the project loads.

- `development` — PO scope, UX contract, implementer, validator, reviewer, ship.
- `fix` — implementer, validator, ship. Use it for small isolated changes.

Run `/flowgraph run development "<objective>"` or
`/flowgraph run fix "<objective>"`. `/flowgraph` lists runs, opens node
sessions, and pauses or resumes them. The workflows use native permissions and
never approve a request for you. Workflow sessions cannot edit `.opencode`,
`opencode.json(c)`, `AGENTS.md`, `.github`, or `.git`.

The OpenCode server process needs `bun` and `gh` on `PATH`; the agents run the
repository checks directly.

## Migrating from 0.1.x

Version `0.2.1` is a full rename:

- npm package: `opencode-agent-workflows` → `opencode-flowgraph`
- plugin ID: `agent-workflows` → `flowgraph`
- RPC ID: `agent_workflows` → `flowgraph`
- reporting tool: `agent_workflows_report` → `flowgraph_report`

Update the plugin entry in `opencode.json(c)` and any agent prompts that call the reporting tool. Runs stored under the old plugin ID are not visible to `0.2.1`; start new runs.

## Releasing

Releases are published to the public npm registry from GitHub Actions using npm Trusted Publishing (OIDC). There is no long-lived npm token in the repository.

`1.0.1` is the next patch. It carries the post-`v1.0.0` harness ownership,
capability-honesty, and Desktop read-only fixes. Do not move the `v1.0.0` tag or
republish `1.0.0`: bump, commit, tag `v1.0.1`, and let the release workflow
publish. Code may be committed and reviewed before the tag; tagging and
publishing remain separate gates.

### Prerequisites

- Public GitHub repository
- npm CLI **11.5.1+**
- Node **22.14+**
- npm account with 2FA enabled

The release workflow installs the latest npm before publishing.

### First publish (one-time bootstrap)

Trusted publishing can only be configured after the package exists on npm. Bootstrap the first version once:

```sh
# From the repository root
npm login
npm publish --access public
```

`npm publish` runs `prepublishOnly`, which typechecks and tests the package.

Then configure the trusted publisher:

1. Open `https://www.npmjs.com/package/@alvarolorentedev/opencode-flowgraph`
2. Open **Settings** and find **Trusted Publisher**
3. Choose **GitHub Actions**
4. Enter:
   - **Organization or user:** `alvarolorentedev`
   - **Repository:** `opencode-flowgraph`
   - **Workflow filename:** `release.yml`
   - **Environment name:** leave blank
   - **Allowed actions:** enable **Allow npm publish**
5. Save.

After the configuration is saved, it must complete its first successful publish within 2 days. If it expires, delete it, recreate it, and publish again.

You can also configure it with npm CLI 11.15+:

```sh
npm trust github @alvarolorentedev/opencode-flowgraph \
  --repo alvarolorentedev/opencode-flowgraph \
  --file release.yml \
  --allow-publish
```

Verify:

```sh
npm trust list @alvarolorentedev/opencode-flowgraph
```

After the trusted publisher works, optionally restrict token publishing:

- Package Settings → Publishing access
- Select **Require two-factor authentication and disallow tokens**

Do not add an `NPM_TOKEN` secret. The release workflow intentionally has no token fallback.

If you cannot publish locally, use a one-time granular token in a temporary workflow for the bootstrap publish only, then revoke it, remove the secret, and configure trusted publishing.

#### Validate trusted publishing with the next version

A new trusted-publisher configuration must complete a successful OIDC publish within **2 days**. The manual bootstrap version does not validate it.

After configuring the trusted publisher, publish the next patch through GitHub Actions:

```sh
npm version patch --no-git-tag-version
git add package.json bun.lock
git commit -m "release: v0.2.2"
git push

git tag v0.2.2
git push origin v0.2.2
```

The workflow publishes `0.2.2` through OIDC and completes the trusted-publisher validation. The bootstrap `0.2.1` has no OIDC provenance; that is expected.

The workflow's version-exists check is only for idempotent reruns. It does not validate a new trusted publisher.

### Release process

```sh
# 1. Bump the version (choose patch/minor/major)
npm version patch --no-git-tag-version

# 2. Commit the version bump
git add package.json bun.lock
git commit -m "release: v0.2.2"
git push

# 3. Tag and push the tag
git tag v0.2.2
git push origin v0.2.2
```

The tag must match `package.json`:

- tag `v0.2.2` → version `0.2.2`

The workflow runs typecheck and tests, publishes with OIDC and automatic provenance, and creates a GitHub release.

You can also create the tag through the GitHub Releases UI. Make sure the tag starts with `v` and matches the package version.

### Verify

```sh
npm view @alvarolorentedev/opencode-flowgraph version
npm view @alvarolorentedev/opencode-flowgraph dist-tags
npm audit signatures
```

### Versioning and compatibility

- Use semver.
- Keep the plugin ID `flowgraph` stable; changing it changes the plugin storage namespace.
- Keep the RPC ID `flowgraph` stable.
- The current peer range is `@opencode/plugin >=2.0.32 <3`.
- A breaking RPC or workflow-schema change should be a major version.
- Prefer `npm deprecate` over unpublishing.

### Rollback

Publish a fixed patch version and deprecate the broken one:

```sh
npm deprecate @alvarolorentedev/opencode-flowgraph@0.4.0 "Broken release; use 0.4.1"
```

Do not rewrite tags. The workflow publishes exactly the tagged commit.

### Troubleshooting

- **`ENEEDAUTH`**: the trusted publisher fields do not match the workflow exactly. Check repository, workflow filename, and `id-token: write`.
- **Provenance missing**: the repository must be public and the publish must use OIDC.
- **Configuration expired**: recreate the trusted publisher and publish within 2 days.
- **Wrong package version**: the tag and `package.json` version must match exactly.
