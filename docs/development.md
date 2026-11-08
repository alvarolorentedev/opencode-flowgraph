# Development

## Architecture and ownership

- OpenCode owns agents, sessions, permissions, models, and tools.
- The plugin owns workflow YAML parsing, graph validation, orchestration, run state, recovery, and Mermaid generation.
- Workflow definitions stay in `.opencode/workflows`.
- Runtime state stays in OpenCode plugin storage, keyed by project.

### Modules

| Module | Responsibility |
|---|---|
| `workflow/schema.ts` | Zod YAML schema and hard limits |
| `workflow/loader.ts` | Safe YAML parsing, discovery, hashing, atomic file operations |
| `workflow/graph.ts` | Pure graph construction, validation, transition resolution |
| `workflow/mermaid.ts` | Pure, escaped, deterministic Mermaid generation |
| `workflow/validator.ts` | Semantic validation and native agent resolution |
| `execution/native-agents.ts` | Typed adapter over OpenCode agents, sessions, and permissions |
| `execution/report-tool.ts` | `flowgraph_report` tool and active-session registry |
| `execution/tool-hooks.ts` | Workflow-session background-work policy and protected configuration guard |
| `execution/prompts.ts` | Bounded context handoff prompts |
| `execution/results.ts` | Result/audit summarization and usage estimates |
| `execution/run-graph.ts` | Structured run graph, active-node state, session mapping, controls |
| `ui/runs.ts` | Cross-project/worktree run discovery, merge, and ordering |
| `ui/graph.ts` | Pure boxed terminal diagram: ranking, rails, tones, width/height fallback |
| `tui.tsx` | TUI workflow page, session panel, command, keyboard controls |
| `gui.tsx` | Experimental Desktop GUI run picker, panel, and Mermaid renderer |
| `execution/runner.ts` | Concurrent session scheduler, controls, limits, and recovery |
| `execution/checkpoint.ts` | Durable branch, call, and join transitions |
| `state/store.ts` | Project-scoped records with revisioned run mutations |
| `state/concurrency.ts` | Host-local run ownership lock |
| `service.ts` | Workflow discovery/validation and run control facade |
| `rpc.ts` | Shared `Rpc.define` contract |
| `contract.ts` | Shared Zod schemas and exported types |
| `rpc/handlers.ts` | Thin RPC handlers and error mapping |
| `index.ts` | Plugin setup, tool/RPC registration, recovery scheduling, cleanup |

### Structured result boundary

V2 agent prompts do not have a native response schema. The plugin uses a typed tool whose input is validated by OpenCode and persisted by the plugin. Free-form phrases such as `DONE` or `LGTM` are never parsed.

The tool is location-wide because OpenCode plugin tools are not session-scoped. Executors reject calls outside an active workflow node session, and background `subagent`/`shell` calls are rejected inside workflow sessions by default.

## Local development

```sh
bun install
bun run typecheck
bun run test
```

The optional real OpenCode plugin-loading/RPC smoke test:

```sh
OPENCODE_SMOKE=1 OPENCODE_BIN=/path/to/opencode bun run test:smoke
```

It starts an isolated `opencode api --standalone` request, loads the plugin from this repository, and calls `capabilities` and `listWorkflows`. It does not make model calls.

The opt-in model-routing integration uses a local OpenAI-compatible mock server and makes no paid model calls:

```sh
OPENCODE_MODEL_INTEGRATION=1 OPENCODE_BIN=/path/to/opencode bun run test:integration
```

It checks the model IDs and variant sent in actual inference requests. The default unit suite still uses `FakeNative` and does not require an OpenCode binary.

A real-model end-to-end verification is manual: define two primary agents, create the workflow, start a run through RPC, verify the review loop, disconnect the client, restart the server, and confirm conservative recovery. See [`operations.md`](operations.md) and [`interfaces.md`](interfaces.md).

A local plugin entry needs a root `index.ts` (server) and `rpc.ts` (shared contract); this repository provides both.

## Migrating from 0.1.x

Version `0.2.1` is a full rename:

- npm package: `opencode-agent-workflows` → `opencode-flowgraph`
- plugin ID: `agent-workflows` → `flowgraph`
- RPC ID: `agent_workflows` → `flowgraph`
- reporting tool: `agent_workflows_report` → `flowgraph_report`

Update the plugin entry in `opencode.json(c)` and any agent prompts that call the reporting tool. Runs stored under the old plugin ID are not visible to `0.2.1`; start new runs.

## Releasing

Releases are published to the public npm registry from GitHub Actions using npm Trusted Publishing (OIDC). There is no long-lived npm token in the repository.

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
