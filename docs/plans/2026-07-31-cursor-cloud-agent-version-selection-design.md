# Cursor Cloud Agent Version Selection Design

## Context

Work Queue launches Cursor Cloud Agents through the server-side Cursor client.
The current client uses Cursor's legacy v0 endpoint and aborts every request
after 15 seconds. Cursor can accept a v0 launch while provisioning the agent
takes longer than that, which produces the misleading client-side error:
`Cursor API request failed: The operation was aborted due to timeout`.

The integration should preserve v0 compatibility, offer a deliberate v0/v1
choice, and avoid creating duplicate agents after an ambiguous timeout.

## Goals

- Keep v0 as the default so existing Postman-tested configurations continue to
  work.
- Let the user select v0 or v1 from Cursor Settings.
- Keep the shared Work Queue `cloudAgent` contract stable across API versions.
- Track the API version on each launched agent so changing the setting does not
  break status checks for existing agents.
- Increase the launch/status HTTP timeout from 15 seconds to 60 seconds by
  default, with a bounded `OPENCHAMBER_CURSOR_REQUEST_TIMEOUT_MS` override.
- Return an actionable timeout error without retrying a POST that may already
  have created an agent.
- Keep credentials server-side and never include them in logs or error output.

## Non-goals

- Replacing the Work Queue UI or changing its review-before-send behavior.
- Automatically retrying a timed-out agent creation.
- Adding Cursor webhook/SSE streaming in this change.
- Changing the v0 launch payload semantics.

## Architecture

### Version configuration

`packages/web/server/lib/workqueue/settings.js` stores a validated
`cursorApiVersion` value in the existing settings file. The optional
`OPENCHAMBER_CURSOR_API_VERSION` environment variable takes precedence and
locks the setting to a valid `v0` or `v1` value. Invalid values fall back to
v0. The settings route exposes the effective version and whether it came from
the environment; a separate version route updates the persisted setting.

The shared Cursor Settings surface adds an accessible v0/v1 selector. It is
disabled when the version is controlled by the environment. Changing the
version affects only future launches.

### Version-specific requests

The server-side client selects a version-specific adapter at request time:

- **v0:** `POST /v0/agents`, `model` is a string, and the repository is sent as
  `source.repository`.
- **v1:** `POST /v1/agents`, `model` is an object (`{ id }`), and the repository
  is sent as `repos: [{ url }]`. The initial response contains separate
  `agent` and `run` records.

Both versions use server-side API-key authentication and return normalized
metadata. v1 uses the API's separate `agent.id` and `run.id`; v0 keeps its
legacy agent ID as the persisted run ID for compatibility.

### Persisted agent metadata

`cloudAgent.apiVersion` is added to the persisted and shared type. Existing
records without this field are treated as v0. New records always record the
effective version. The status route uses the record's version rather than the
current setting.

For v1, status reads the agent metadata and the stored/latest run. The run
status is authoritative, and branch data is read from `run.git.branches`. For
v0, status continues to read `status` and `target` from the agent response.

## Timeout and error handling

The default Cursor HTTP request timeout is 60 seconds. The environment override
is parsed and clamped to a safe range so an accidental value cannot disable the
timeout or create an unbounded server request. The OpenChamber server's
existing long-request limit is longer than this default.

Timeouts are represented by a `CursorApiError` with a timeout code and an
actionable message. The launch route returns HTTP 504 for this error and 502
for other upstream failures. No automatic retry is performed because the
Cursor POST may have been accepted even if its response did not reach
OpenChamber.

## Data flow

1. Cursor Settings loads the current auth/version status.
2. The user selects v0 or v1 unless an env override controls the version.
3. The cloud-agent draft and launch route resolve the same effective version.
4. The client sends the version-specific payload and normalizes the response.
5. The route persists the normalized metadata, including `apiVersion`, and
   moves a todo item to `in_progress` as before.
6. Future status checks use the persisted version and v0/v1-specific response
   mapping.

## Testing strategy

Focused server tests will cover:

- v0 URL, authentication, and legacy payload shape;
- v1 URL, payload shape, model object, and `{ agent, run }` normalization;
- version setting validation and default/legacy behavior;
- v1 run-aware status and v0 compatibility for old records;
- timeout classification, message, and the absence of retries.

Existing Work Queue tests must remain green. The web and UI type-check/lint
commands will validate the shared settings/API contract, and the dead-code
report will be inspected if exports or types change.

## Rollback

Setting the version back to v0 restores the current endpoint and payload
behavior. Removing the optional env override restores persisted settings
control. The client adapters are isolated so a future v1 issue can be handled
without changing the Work Queue UI or stored v0 agent records.
