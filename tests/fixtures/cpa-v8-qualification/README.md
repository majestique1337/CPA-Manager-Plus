# CPA v8 qualification evidence — AQ-01

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
