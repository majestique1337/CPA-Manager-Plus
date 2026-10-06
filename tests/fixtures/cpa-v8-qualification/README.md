# CPA v8 qualification evidence

## AQ-02 r2 management runner

The checked-in manifest now contains **101 cases**: 95 management leaves in 36
groups and six retained downstream declarations. The normal case set selects 92
leaves. One natural-expiry leaf has its own case set. Real provider refresh and
successful OAuth exchange remain required and unselected in this offline scope.
The validator retains the r1 catalogue through `createSeedManifest()` and all r1
regressions. `createManagementManifest()` returns the frozen r2 catalogue.

| Input                           | Identity                                                                  |
| ------------------------------- | ------------------------------------------------------------------------- |
| AQ-01 merged prerequisite head  | `32ba418c2a5f09aaaba0f887a8d429da91df2fbe`                                |
| AQ-02 implementation base on v2 | `5bb3a5b88e234a2e8315af694388e72bc0bfe804`                                |
| Planning repository commit      | `b654d625902c0e810f9bfc581aa17c35f4b0cff0`                                |
| Gate blob                       | `d5367e63d4feda5854d0639746c18d6a78e0b274`                                |
| Profile composition             | r1: 16 operations, seven profiles, five required selections               |
| Tool base                       | Node 24.13.0 bookworm-slim, Linux amd64                                   |
| Tool base manifest digest       | `sha256:46feb5752989c05b8606e6323fbbc3db667d14ade1c24f5d0d44d9ca9909d607` |

The candidate archive/version/commit/digest are unchanged from r1 below. The
Python helper pins the archive size to 22,952,865 bytes, audits exactly five
regular members, verifies ELF64/little-endian/x86-64 and records the binary hash.
It uses Python 3.11+ stdlib and never downloads or executes an archive member.
An existing staging destination, links, unsafe ownership/modes, changed input,
CRC/truncation, oversized metadata and input limits cause rejection and cleanup.

### Local tool checks

```sh
node bin/ci/run-cpa-v8-qualification.mjs --manifest tests/fixtures/cpa-v8-qualification/manifest.json
npx vitest run tests/cpaV8QualificationRunner.test.mjs tests/cpaV8EvidenceContract.test.mjs tests/prCheckClassifier.test.mjs
npm run test:repo
```

The first command only checks the declared plan; it performs no network request,
spawn, CPA execution or write. The normal PR checks use synthetic archives,
owned fake children, local HTTP fixtures and mock time for tool arithmetic.
They never download CPA, use real accounts or run the 37-minute expiry case.
Missing Python is a test failure, not a skipped success.

### Build and isolated execution

Build from a clean **committed** implementation for independent acceptance:

```sh
git ls-files --error-unmatch bin/ci/run-cpa-v8-qualification.mjs bin/ci/prepare-cpa-v8-artifact.py bin/ci/validate-cpa-v8-evidence.mjs
git diff --exit-code HEAD -- bin/ci/run-cpa-v8-qualification.mjs bin/ci/prepare-cpa-v8-artifact.py bin/ci/validate-cpa-v8-evidence.mjs
docker build --platform linux/amd64 \
  --build-arg RUNNER_COMMIT="$(git rev-parse HEAD)" \
  -f tests/fixtures/cpa-v8-qualification/Dockerfile.runner \
  -t cpamp-aq02-tool:reviewed .
docker image inspect cpamp-aq02-tool:reviewed --format '{{.Id}}'
```

The image records the actual Node, Python and libc versions and hashes of the
runner, validator and archive helper. Freeze the resulting image digest before
execution. Rebuilds after package updates are distinct tool identities. A build
argument alone does not prove a commit contains the copied source; independent
acceptance must check both the clean source and recorded file hashes.

Use a new owned host directory with mode 0700 for each run. Place the explicitly
obtained official archive in an immutable owned regular file with mode 0600.
Copy the canonical manifest into that directory, create an empty `inspect.json`
file with mode 0600, and create an empty `output/` directory with mode 0700.
Set the example variables to absolute paths and the frozen local image digest:

```sh
docker create --name "$AQ02_CONTAINER" --platform linux/amd64 \
  --user "$(id -u)" --init --read-only --network none \
  --cap-drop ALL --security-opt no-new-privileges \
  --pids-limit 128 --memory 1g --cpus 2 \
  --mount "type=bind,src=$AQ02_ARCHIVE,dst=/input/CLIProxyAPI_8.0.13_linux_amd64.tar.gz,readonly" \
  --mount "type=bind,src=$AQ02_RUN_DIR/manifest.json,dst=/run/aq02-manifest.json,readonly" \
  --mount "type=bind,src=$AQ02_RUN_DIR/inspect.json,dst=/run/aq02-isolation.json,readonly" \
  --mount "type=bind,src=$AQ02_RUN_DIR/output,dst=/work" \
  "$AQ02_IMAGE_DIGEST" --run --manifest /run/aq02-manifest.json \
  --archive /input/CLIProxyAPI_8.0.13_linux_amd64.tar.gz \
  --output-parent /work --case-set management-r2
docker inspect "$AQ02_CONTAINER" --format '{{json .}}' > "$AQ02_RUN_DIR/inspect.json"
docker start --attach "$AQ02_CONTAINER"
```

The host's read-only inspect document is cross-checked against live Linux
properties: only loopback interfaces, a read-only root, no capabilities and
no-new-privileges. It must declare the frozen image, non-root user, bounded CPU,
memory and PIDs, and exactly the three read-only inputs plus private output
mount. There is no Docker socket, host networking, published port, production
mount or fallback to host execution. Host inspect authenticity still belongs to
the trusted operator and independent acceptance; this is not hostile same-user
process isolation.

For natural expiry, create another new container/output directory and replace
the case set with `oauth-expiry-r2`. Only M32 receives the 37-minute case and
40-minute slice budget; ordinary cases retain 90 seconds / 15 minutes. Requests
remain bounded to five seconds, 32 KiB headers and 1 MiB bodies. Encoded bodies
are rejected; redirects are not followed. The long run polls the same live
Codex state every 15 seconds, preserves pending/error/expiry observations and
checks no credential was saved. It never cancels or restarts the flow to create
an expiry result. Mock time tests do not produce upstream evidence.

### Observation and safety boundaries

- Every case owns a fresh config, secrets, auth directory, CPA process group and
  local OpenAI-compatible stub. The child environment is constructed from an
  empty allowlist. `--local-model`, disabled panel/plugins/discovery and the
  network namespace prevent unrelated services or inherited proxy/store state.
- Management/client/upstream keys are independent. Successful data-plane
  controls must reach the stub; missing/wrong keys must not reach it. A provider
  error is a separate observation. Stub success does not qualify a real provider.
- Startup waits for a TCP listener before its semantic config probe. Only a
  transient transport failure may retry that read once; authentication failures
  and semantic mismatches stop immediately. The complete startup sequence,
  including the no-secret data-plane control, shares a 30-second deadline.
- Config writes require persisted readback and actual client-key behavior.
  Map PATCH preserves unrelated root fields; list PATCH replaces the family.
  JSON root PUT preserves omitted matching TURN secrets; YAML replacement drops
  them. YAML GET is a normalized view and must leave the stored file unchanged.
- Empty/absent/null client-key families are observed explicitly. They must not
  be described as deny-all. Credential upload/status/fields have file and runtime
  postconditions; synthetic credentials do not prove provider usability.
- M20 applies Linux `RLIMIT_FSIZE` only to the recorded CPA child to induce a
  write failure. CPA can restore chmod write permissions, so chmod alone is not
  a valid failure fixture. A failed write may truncate private configuration;
  the replacement client key must not silently become effective.
- M25's offline refresh-error leaf uses an existing name with a mismatched
  auth index. Its positive control proves the credential exists. Real provider
  refresh and M33's complete OAuth exchange/save/replay sequence remain pending.
- Callback acceptance, a temporary callback file and an error callback are
  separate from token exchange and committed credentials. Repeated callback and
  cancellation races record the observed limits without claiming exactly-once.
- Mutation response loss is deliberate client-side discard followed by readback;
  the mutation is sent once. No CAS, operation lookup or automatic replay is
  inferred. Ordinary effective-state polling stays within its case deadline.
- Child logs are discarded with a 1 MiB cap. Graceful shutdown is bounded and
  escalates only for the recorded process group. Incomplete shutdown preserves
  private files and marks cleanup failed. Cancellation retains completed cases
  and any already-observed long-run state; it cannot fill pending results green.

Each run creates a new `run-*` directory with its manifest, sanitized traces,
report and tool/isolation identity. Raw config, auth files, response bodies,
OAuth state/code and child output stay private and are removed only after owned
child and fixture shutdown is proved. Never publish private leftovers after a
cleanup failure. Validate the saved report with the matching manifest and
evidence directory before acceptance.

Exit 0 means only that all selected mandatory assertions passed, setup/cleanup
completed and the evidence validator accepted the report. Failures, aborts,
timeouts or invalid inputs return 1; invalid CLI usage returns 2. Required
unselected cases remain pending. Neither an exit code nor structural counters
sign profile qualification, independent acceptance, Phase4A or production use.

Development runs must retain their original manifest/image/source hashes and
failures. Reports made before the implementation is committed are development
observations; a baseline SHA plus modified source is not final exact-head
acceptance. Commit-bound qualification and independent acceptance remain later
gates. AQ-03/04/05, real provider deltas, product consumers and #870 stay under
their existing owners.

## AQ-01 r1 historical foundation

This is the **r1 evidence-format foundation**. No CPA artifact was downloaded,
started or qualified by this slice. The 16 seed cases declare intent, not complete
surface, field, provider, failure or recovery coverage. Seven profiles have five
mandatory selections and two disabled optional selections.

## Frozen inputs

| Input                                            | Identity                                                          |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| Planning repository commit                       | 85d4f9942049fb3fdbf8358a5d8a9d7624f110bd                          |
| CPA v8 Gate blob                                 | 779860b2126a95b1878af6645497e95419ce1775                          |
| Explicitly selected local v2 implementation base | f5d12c6ca4af1f36f087e8acd28e565c5a0ae655                          |
| Source-observed CPA candidate                    | v8.0.13 at d7914afdedca7af95ee974a42453dc49fc1388ce               |
| Candidate artifact                               | Linux amd64 plugin variant, CLIProxyAPI_8.0.13_linux_amd64.tar.gz |
| Declared archive SHA256                          | 50ecffb47fdd81c8c5a9825a73a7a905ab66342337e274f39c4276b92d3533f3  |

The draft was shaped against v2 at 58076c6e26c372f179695d6754e3dc306190191f.
The selected local base predates PR #888; those five identity-consumer files do
not intersect AQ-01. This fixture records the actual base and does not accept a
production identity consumer or replace its later acceptance.

Routes were read from CPA's internal/api/server_management_v8.go,
internal/api/handlers/management/config_v8.go and internal/api/server_routes.go
at the candidate commit. Digest and routes are declared/source-observed inputs,
not locally observed binary evidence.

## Use

From the repository root:

```sh
node bin/ci/validate-cpa-v8-evidence.mjs --manifest tests/fixtures/cpa-v8-qualification/manifest.json
node bin/ci/validate-cpa-v8-evidence.mjs --manifest /owned/manifest.json --report /owned/report.json --evidence-root /owned/evidence
npx vitest run tests/cpaV8EvidenceContract.test.mjs tests/prCheckClassifier.test.mjs
npm run test:repo
```

Only --manifest, --report and --evidence-root are accepted; report and
evidence-root must appear together. There is no environment credential fallback,
URL/executable input, network, subprocess, download, CPA execution or file write.
The module exposes validateEvidence and createSeedManifest; both are read-only.
The latter returns a fresh copy of the trusted r1 declarations.

| Exit | Meaning                                                          |
| ---- | ---------------------------------------------------------------- |
| 0    | manifest_valid or report_valid: format/references are consistent |
| 1    | invalid data, binding, state, privacy or file boundary           |
| 2    | invalid CLI usage                                                |

The CLI emits one JSON line and no raw stderr. Success does not authenticate
observations or sign acceptance. Fabricated runtime-shaped reports can be
structurally valid; independent acceptance must inspect actual bytes, execution,
postconditions and original traces.

Output counts declared, selected, completed, pending, requiredPending,
setupFailures and cleanupFailures. pending counts uncompleted seed cases;
requiredPending counts required seed cases without completed supported results.
These are structural counters, not qualification. Zero cannot clear a Gate;
cleanup failure remains a blocker despite retained completed observations.
No input-supplied ID, path, secret or arbitrary string is echoed.

## Format and budgets

Manifest, report and traces use UTF-8 without BOM and exactly
JSON.stringify(value, null, 2) plus one LF. Object key order follows the decoded
object. Unknown fields/versions/revisions/identities, duplicate members, unsafe
or noncanonical numbers and noncanonical bytes fail closed. No input is rewritten.

| Object                                         | Limit                |
| ---------------------------------------------- | -------------------- |
| Manifest / report                              | 1 MiB / 4 MiB        |
| Cases / results / evidence entries             | 256 each             |
| Profiles / operations / fixtures               | Exact r1: 7 / 16 / 4 |
| Surfaces per operation / expectations per case | 32 / 32              |
| Profile refs / surface refs per case           | 7 / 32               |
| JSON depth / decoded nodes                     | 16 / 65,536          |
| Generic array elements or object members       | 256 per container    |
| Trace / all traces                             | 1 MiB / 16 MiB       |
| Trace records                                  | 32                   |
| Safe ID / evidence relative path length        | 96 / 256 characters  |

Reads consume at most limit+1 bytes to detect overflow. Inputs must be regular
files. Evidence root must be an owned immutable directory at its real absolute
path, without untrusted concurrent writers. Root/subdirectories cannot be
group/world writable. Files must be owned, not group/world writable, regular,
single-link files. Symlinks, aliases, traversal, URL/encoded paths and observed
path/inode drift fail closed. File identity is checked around the bounded read;
directory identity and real paths are checked around evidence verification.
This does not isolate hostile same-user concurrent processes. Stabilize inputs
before validation; arbitrary shared mutable trees are outside the contract.

Traces allow only schemaVersion, runId, caseRef and records. Each record binds
expectationRef, outcome, safe observationCode, HTTP status and safe integer
elapsed/byte counters. Every executed assertion needs a matching typed record. A
not_run assertion has observationCode NONE and no execution trace. Hash alone,
empty trace or foreign run/case/expectation references cannot support an assertion.
Raw bodies/config/headers, credentials, OAuth state/code and free-form errors are
not shared evidence.

## Proof boundaries and next owners

- Exact r1 operation/profile composition, candidate and fixture inputs are fixed.
  Changes require reviewed scope/revision deltas; optional profiles remain disabled.
- Each composite operation separates method/path/effect/auth. Core Management is
  v8 only. Client-key POST /v1/chat/completions is data-plane auth. Queue GET consumes;
  OAuth auth-url GET starts a flow; neither is probe eligible. Callback uses
  oauth-state authority. Undeclared extensions have no fabricated routes.
- Fixture config/mode IDs declare future isolated categories. Equality does not
  prove effective config/network mode. STAGE later references AUTH/CFG/KEY/CRED/MODEL
  postconditions; plugin consumers similarly consume AUTH/CFG/OAUTH evidence.
- not_run and aborted stay unknown. Supported functions require upstream-real /
  upstream-function, an upstream run, matching observed archive/binary identity,
  passing mandatory assertions and typed traces. Guard/harness cannot support a
  function. Foundation has no verified artifact and its functions remain unknown.
- Optional assertion outcomes remain visible without overruling passing mandatory
  assertions. A completed result cannot carry a not-run or abort reason such as
  NOT_IMPLEMENTED or TIMEOUT; those retain their own execution state and uncertainty.
- AQ-02 owns the real isolated runner and complete management cases; AQ-03 External
  safety; AQ-04 usage/staging failures; AQ-05 extension guards and independent
  pre-4A Go/No-Go. Consumers have separate exits. AQ-01 does not advance Phase4A,
  resume #870 or enable plugins.

## Verification

Tests contain three positive format families: declared seed, not-run foundation
and partial runtime-shaped reports. Runtime-shaped data and hashes are synthetic,
generated in private temporary directories, and are not actual CPA evidence.

V-AQ01-01 through 24 cover canonical/size/schema/ref boundaries, mixed identity,
coverage, surface safety, false support, run state, owned evidence, trace binding,
privacy and tool inputs. Subprocess tests trap network/process/write APIs, observe
limit+1 reads and inject root identity drift. Only the owning harness cleans its
temporary files.

Validator-only changes trigger Frontend/repo checks. Manifest, fixture README and
contract tests already trigger that job via tests/. Changes to the classifier or
its regression test preserve the existing all-checks rule. No workflow or new
dependency is added. Local success is not a GitHub job result: actual PR checks
and independent acceptance remain pending until the exact PR head is verified.

Order: usage; bounded decode/depth/canonical; field/type; ID/ref/coverage;
surface/artifact; state/assertion; evidence/privacy. Fixed diagnostic codes:

```text
USAGE INPUT_INVALID INPUT_LIMIT NON_CANONICAL SCHEMA_VERSION FIELD_REJECTED
ID_OR_REF_INVALID COVERAGE_INVALID SURFACE_POLICY_INVALID ARTIFACT_BINDING_INVALID
RESULT_STATE_INVALID EVIDENCE_INVALID PRIVACY_REJECTED SIDE_EFFECT_REJECTED
```
