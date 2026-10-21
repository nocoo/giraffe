# Source Index Performance

## Measurement boundary

The October 2026 consumer report measured about 606 KB / 9.7 s for `/sources`
and 7.3 s with `since`. These production timings are reported symptoms, not
measurements made by this change. No production refresh, D1 query trace or zone
configuration change was performed.

Local profiling uses Bun 1.4.3 on macOS arm64 and the existing in-memory SQLite
test adapter. It executes the production reader against deterministic saved data:
126 repositories, five snapshot resources and publication metadata for seven factory
streams per repository, plus five account sources (1,517 total). Each repository has
40 issues, 30 PRs, 60 Actions runs and 12 releases. The fixture includes old aliases, removed history,
mixed publication versions and incomplete coverage. Its 644 stored snapshot rows
contain 8,784,588 payload bytes. The original batch-3 fixture did not include the
referenced immutable stream payloads; the v0.17.0 regression fixture adds them as
described below. Fake URLs use `github.example`; reads forbid fetch and verify
that saved rows are unchanged.

Each scenario uses three warmups and twelve timed samples. Separate detailed
traces instrument queries, JSON parsing/stringification and digest submission;
their instrumentation overhead is not included in the timing table. This is a
local SQLite/JSC measurement, not deployed D1/V8 or a network-latency simulation.

## Batch-3 baseline before optimization

| Request | Sources | Reader queries | Read median / p95 (ms) | SQLite median (ms) | Serialization median (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Full | 1,517 | 14 | 37.114 / 40.396 | 3.829 | 0.309 |
| Since, newer two-thirds | 1,012 | 14 | 35.668 / 37.287 | 4.188 | 0.192 |
| Since, empty result | 0 | 14 | 34.519 / 37.962 | 3.573 | 0.002 |
| One repository | 17 | 17 | 28.224 / 28.603 | 3.718 | 0.012 |

Bearer authentication adds one query outside these reader counts. The full
response is 593,822 bytes; the repository-filtered response still includes all
five account sources and the complete repository-name list.

The reader is not a per-repository N+1: query count is constant, but the same data
is read repeatedly. Three policy queries precede a repository-page scan, then
account issues/PR/CI projections repeat those page reads. Factory publication and
catalog data are also reread. The full request transfers 16,759,543 payload bytes
from SQLite, almost twice the fixture's saved payload. A repository filter adds
another three-query policy lookup without eliminating the global projections.

The detailed full trace performs 1,286 JSON parses (12.984 ms), 8,194 JSON
stringifications (5.691 ms), and 634 content digests over 12,315,620 bytes. Most
small stringifications construct CI workflow keys. Repository-source assembly
takes 17.231 ms and CI projection 9.556 ms in that trace. Async digest wait times
overlap and must not be summed as wall time. Final response serialization is a
small fraction of the cost. `since` previously filtered only after all this work,
so even an empty result performed every read, projection and digest.

Query plans already use the `(account_id,kind)` primary-key index. Suffix scans
use its account prefix, while exact-kind reads use both columns. SQLite execution
is only about 3.8 ms locally; another ordinary kind index would not remove repeated
payload transfer and decoding. That snapshot-only profile did not justify another
index or migration; it did not test later read-time stream hashing.

## Batch-3 optimization

The request now reads policy once (three queries), reads the publication head
once, then bulk-loads only the needed account/repository pages and selected
publication in one query. Decoded page groups feed both the source index and the
shared account/CI projections. Catalog and publication data are reused; source
time filtering happens before unnecessary full-version digests. That change added
no persistent cache, dependency, index migration or refresh requirement. The
v0.17.0 metadata migration below is a separate change.

The comparable after run uses the same deterministic fixture, runtime, warmups,
sample count and profiling harness as the before run:

| Request | Queries before / after | Read median before / after (ms) | After p95 (ms) | After SQLite median (ms) | After serialization median (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Full | 14 / 5 | 37.114 / 27.870 | 29.219 | 1.748 | 0.302 |
| Since, newer two-thirds | 14 / 5 | 35.668 / 25.479 | 26.978 | 1.740 | 0.195 |
| Since, empty result | 14 / 5 | 34.519 / 14.018 | 16.366 | 1.772 | 0.002 |
| One repository | 17 / 5 | 28.224 / 19.535 | 21.557 | 1.843 | 0.012 |

All four scenarios have exactly the same response-body SHA-256 before and after.
Full payload transfer falls from 16,759,543 to 8,784,588 bytes. JSON parsing falls
from 1,286 calls / 12.984 ms to 644 / 6.199 ms in the detailed full traces. Full
full-version hashing still reflects every actual snapshot source; the empty-since
case avoids all 634 previous digests. Full local read time improves about 25%, and empty-since
time about 59%. This does not establish a production latency percentage.

The maintained fixture, query counter and standalone benchmark now extend this
dataset with real stream payloads and structural checks:

```bash
bun run tests/bench/sources.ts
bun run test apps/web/src/server/lib/machine-sources.test.ts
```

The benchmark prints twelve raw samples, median/p95 timing, payload/query counts,
response hashes and separate parsing/stringification/digest measurements for each
scenario. Timing varies with runtime and concurrent load; regression tests enforce
the five-query bound, zero factory stream payload reads and source/content
semantics, not a noisy wall-clock limit.
The machine request's bearer lookup is additional. Volatile rate projection adds
one query only to actual account `/factory` responses, not `/sources` or streams.

## Persisted content versions (v0.17.0)

The first content-version implementation stayed within five queries but loaded
and parsed every referenced stream to hash its content before source filtering.
The original metadata-only stream fixture missed that amplification. The revised
fixture stores one valid commits stream of about 931 KB per repository, under the
1.2 MB stream limit: 126 stream rows add 117,101,385 payload bytes to the existing
8,784,588 snapshot bytes. Other stream identities retain publication metadata.
Fresh fixture writes also populate content metadata; timings exclude fixture/hash
setup. Separate legacy cases verify null rather than benefiting silently from a
fixture with no hashes.

Filtering streams before hashing was insufficient: it improved empty requests but
still read and hashed about 78 MB for the newer two-thirds and 931 KB for one
repository. Content hashes now belong to the write path. Snapshot/publication
writes hash the assembled, size-bounded saved value, while factory stream writes
hash saved raw stream data with content-only `ranges:[checkpoint.window]`
substitution. A drained pagination queue cannot stand in for the immutable
observation window. The persisted payload/full version stays unchanged; root
`source_fetched_at` and coverage request URL `source` are excluded collection
metadata, while `source_head` stays included. Metadata and payload are committed
together under the existing transaction/fencing rules. Reads project the saved
hash; account sources hash only a compact composition of saved dependency hashes and selection/quality
metadata. An optional stored `fullVersion` also preserves the exact existing
UTF-8 SHA-256 of `JSON.stringify(prSnapshot(finalSavedData))`, avoiding raw
snapshot full-version recomputation. Account projections still derive full
versions from projected JSON as before. No GET backfill, cross-request cache or
upstream read is introduced.
The [API recipe](api.md#content-version-recipe) defines canonicalization, exclusions,
composite inputs and nullable legacy behavior.

The same Bun/SQLite runtime, three warmups and twelve samples produced these
real-stream measurements. Batch-3 medians remain the acceptance baseline; the
target is no more than about 15% slower in each scenario. The filter-first column
is rejected intermediate evidence, not the shipped implementation.

| Request | Batch-3 median (ms) | Eager hash median / p95 (ms) | Filter-first median (ms) | Stored hash median / p95 (ms) | Change from batch 3 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Full | 27.900 | 410.266 / 420.211 | 348.672 | 25.009 / 26.543 | -10.4% |
| Since, newer two-thirds | 25.500 | 362.817 / 369.914 | 255.446 | 24.122 / 29.685 | -5.4% |
| Since, empty result | 14.000 | 198.341 / 352.442 | 15.772 | 12.746 / 13.234 | -9.0% |
| One repository | 19.500 | 252.217 / 255.477 | 66.004 | 22.057 / 24.329 | +13.1% |

The final run meets the approximate 15% budget: full, partial and empty requests
are faster than batch 3; the single-repository request is 13.1% slower while
still projecting all five account sources. Percentages use the owner's rounded
batch-3 acceptance baselines. These are local measurements, not edge latency.

| Request | Eager payload bytes | Filter-first payload bytes | Stored-hash payload-byte bound | Factory stream payload bytes allowed |
| --- | ---: | ---: | ---: | ---: |
| Full | 125,885,973 | 125,885,973 | 8,784,588 | 0 |
| Since, newer two-thirds | 125,885,973 | 86,853,012 | 8,784,588 | 0 |
| Since, empty result | 125,885,973 | 8,784,588 | 8,784,588 | 0 |
| One repository | 125,885,973 | 9,715,439 | 8,784,588 | 0 |

These byte bounds exclude the small metadata column and count payload returned
from SQLite, not on-wire HTTP bytes. Unit regressions assert that no factory
stream payload is selected/decoded, including full, empty-since and single-repo
requests; query-count checks alone cannot prove that. Covering-index query-plan
checks guard against traversing large row payloads merely to reach metadata.
The existing full `version`/`sourceVersion` recipes and ETag behavior stay intact;
new content fields mean historical complete response hashes are not a
cross-release equality promise.

### Additive migration and rollback

`0014_source_content.sql` adds nullable TEXT `content_meta` to `snapshots` and
`factory_resources`, and indexes:

- `snapshots_content(account_id,kind,content_meta)`
- `factory_resources_content(run_id,repo,stream,content_meta)`

The indexes cover metadata-only stream lookups. An ordinary non-covering lookup
can touch large SQLite payload/overflow pages even when SQL omits `payload`.
Neither table is rebuilt and no old payload is decoded or backfilled. Stored
metadata is `{hash,version?,fullVersion?}`; version is the saved run ID where
present, and fullVersion stores the unchanged full snapshot digest. Old rows
remain null until their next ordinary refresh/save. Aggregates are null while an
existing dependency is unhashed; consumers compare full versions whenever either
content hash is absent/null and omit null hashes when publishing report sources.

Apply migrations before deploying code that selects the columns. Verify on a
local SQL backup copy with
`bun scripts/verify-factory-migration.ts <local-export.sql>`; the verifier checks
old-column row preservation, additive columns/indexes and integrity. Migration
tracking prevents reapplying the ALTER statements; local verification recognizes
the fully applied columns and rejects partial application. This task performs no
production export, migration or refresh. Retain the additive columns/indexes when
rolling back Worker code, and stop collection/queue/cron as in the existing
[factory rollback runbook](09-factory-runs.md); do not drop data to roll back.

## Semantic constraints

- Reuse data only within one authenticated request; never persist a GET cache or
  fetch upstream to repair missing evidence.
- Snapshot versions remain hashes of the actual assembled/projected observation
  data, not timestamps or hashes of input identities.
- Assemble each original-casing page group with its own second page. Repository
  and CI sources choose the newest alias; account inbox projections can retain an
  older complete alias instead of a newer incomplete one.
- Repository filtering keeps account sources and the entire catalog. `since`
  compares the newest valid source/freshness time strictly, retaining unknown times.
- Preserve missing coverage, flags, immutable publication versions and original
  observation windows. Saved source versions must agree with their data endpoints.

## Batch-7 addendum: cross-release latency and body check

The October 22 consumer report compares production v0.17.0 at 2.49-3.14 seconds /
636 KB with v0.16.x at 1.71-2.33 seconds / 603 KB. These supplied end-to-end timings
include network/edge behavior and are **not reproduced by the local reader test**.
No production endpoint, remote D1, Access/WAF setting or refresh was used here.

Compare immutable readers `91f7be2` (v0.16.1), `501ad56` (v0.17.0 / origin/main)
and `890a417` (batch-7 v0.17.1). The two historical readers run in temporary
detached worktrees with their own schema and fixture code; installed dependencies
are shared through a symlink, and their lockfiles match. Only those temporary
worktrees are removed after review. Version 0.17.1 remains unchanged.

The audit harness extends the scenarios and boundaries in `tests/bench/sources.ts`:
Bun 1.4.3, its SQLite 3.54.0, macOS arm64, 126 repositories, 644 snapshot rows /
8,784,588 payload bytes, and 126 actual stream rows / 117,101,385 payload bytes.
The existing `populateSourceStreams` supplies the real-stream variant; v0.16.1 uses
the same stream payload construction without the then-absent metadata column.
Fixture setup/hash writes are excluded. Three process rounds rotate revision
order; each scenario has eight warmups and 40 samples per round. Tables pool the
120 samples, using nearest-rank median/p95. Reads run serially, with network and
reader writes forbidden. Query wrappers account for returned payload/metadata
bytes inside read timing; final response serialization is measured separately.
Detailed JSON/digest instrumentation is outside the timed samples.

### Native/stored metadata fixture

The 0.17.x fixture has saved hashes for existing snapshots and commits streams;
other advertised stream identities have no saved resource/hash. The full result
therefore still has 756 null content hashes. Version 0.16.1 has no content metadata
column or response field, even in this comparison: it is the unchanged historical
contract, not a modified current response.

| Request | v0.16.1 median / p95 (ms) | v0.17.0 median / p95 (ms) | Batch-7 median / p95 (ms) |
| --- | ---: | ---: | ---: |
| Full | 30.433 / 33.833 | 24.468 / 27.021 | 24.719 / 27.117 |
| Since, newer two-thirds | 27.826 / 31.545 | 24.031 / 26.944 | 23.940 / 26.033 |
| Since, empty result | 16.620 / 18.309 | 12.872 / 14.224 | 12.569 / 14.304 |
| One repository | 21.810 / 22.993 | 23.100 / 24.439 | 22.896 / 24.507 |

### Legacy/all-null metadata fixture

Only the owned fixture's `content_meta` columns are cleared after proving its test
marker. Every 0.17.x source explicitly retains `contentVersion:null` and all eight
documented fields. The 0.16.1 schema is already metadata-free; its independently
repeated measurements show the normal timing variation of the same old reader.

| Request | v0.16.1 median / p95 (ms) | v0.17.0 median / p95 (ms) | Batch-7 median / p95 (ms) |
| --- | ---: | ---: | ---: |
| Full | 30.536 / 32.521 | 31.686 / 34.671 | 31.121 / 35.123 |
| Since, newer two-thirds | 27.897 / 31.591 | 28.271 / 31.305 | 28.654 / 30.749 |
| Since, empty result | 16.370 / 18.755 | 11.939 / 13.641 | 12.105 / 13.448 |
| One repository | 21.238 / 23.103 | 22.274 / 23.886 | 22.000 / 24.290 |

**Every revision/mode/scenario uses five reader queries and returns exactly
8,784,588 snapshot payload bytes from SQLite, with zero stream payload bytes.**
Authentication and HTTP/ETag processing are outside this reader boundary.
Response hashes stay identical across repeated samples of each revision/mode/query;
cross-release hashes are not expected to match when fields or freshness semantics
change. The byte counts below apply to both 0.17.x readers; v0.16.1 sizes are the
same in its two independently timed modes.

| Request | Sources | v0.16.1 response bytes | 0.17.x stored response bytes | 0.17.x legacy response bytes | Stored metadata bytes read |
| --- | ---: | ---: | ---: | ---: | ---: |
| Full | 1,517 | 593,822 | 679,705 | 627,196 | 134,338 |
| Since, newer two-thirds | 1,012 | 397,022 | 454,338 | 419,286 | 126,064 |
| Since, empty result | 0 | 2,841 | 2,841 | 2,841 | 109,516 |
| One repository | 17 | 9,067 | 10,200 | 9,441 | 109,713 |

Legacy metadata bytes read are zero. All response sizes are uncompressed UTF-8
JSON, not measured wire bytes. The full legacy increase is exactly **33,374 bytes
= 1,517 x 22**, the serialized `"contentVersion":null` property and separator.
It is required contract data, not justification to omit the field. Saved non-null
hashes are longer, so the stored fixture intentionally has a larger response.

### Cost attribution and decision

The largest directly isolated added work is the bounded metadata lookup, not
repeated content hashing or response serialization. Full legacy SQLite median
rises from 1.781 ms in 0.16.1 to 2.383 ms in 0.17.0. A separate three-round,
120-sample 0.17.0 diagnostic suppresses only the bulk stream-metadata SQL branches
in an external read adapter, **only for the proven all-null fixture**:

| Request | Normal read / SQLite median (ms) | Diagnostic read / SQLite median (ms) |
| --- | ---: | ---: |
| Full | 30.725 / 2.349 | 30.343 / 1.878 |
| Since, newer two-thirds | 27.832 / 2.182 | 27.463 / 1.868 |
| Since, empty result | 11.743 / 1.990 | 11.660 / 1.861 |
| One repository | 21.438 / 1.881 | 21.399 / 1.852 |

All diagnostic response bytes/hashes match the normal legacy response, including
all eight fields. This is an attribution probe, **not shipped code or a safe
production shortcut**: a reader cannot assume that saved hashes remain absent
after refresh. The normal reader and metadata indexes remain unchanged.

Separate full-read traces show:

- Legacy: 644 payload parses, no metadata JSON parses, and the same 634 full-version
  digests over 12,736,040 bytes in all three readers. Null composite inputs already
  avoid content-hash computation; caching or deduplicating absent metadata would
  not remove the dominant payload/legacy-version work.
- Stored 0.17.0: 770 metadata parses cost about 0.155 ms; persisted full versions
  reduce digest work to nine calls / 4,913,502 bytes. Request inputs are already
  shared. Extra canonical composite serialization is small and full reads are
  faster than 0.16.1, not slower.
- Full legacy final serialization medians are 0.318 / 0.338 / 0.328 ms for
  0.16.1 / 0.17.0 / batch 7. The required null properties do not locally explain
  a seconds-scale latency change. Digest submission timings are not summed as
  synchronous elapsed time because asynchronous digest work can overlap.

The measured 0.17.0 legacy median increases are 1.3-4.9% on nonempty requests;
batch 7 is 1.9-3.6% above 0.16.1, while empty-since is about 26% faster. All remain
within the existing approximate 15% local budget. There is **no meaningful local
regression matching the production report**, so this addendum changes documentation
only: no runtime optimization, schema/index change, response omission, new cache,
dependency, ETag/304 change or quality-gate change. Production network/edge latency
remains unmeasured here, and these results do not prove its cause.

Raw samples, separate traces and the standalone comparison/diagnostic harness are
archived locally under `$(git rev-parse --git-common-dir)/batch7-addendum-logs/`;
the PR body includes these before/after tables and revision identities. The
maintained benchmark still runs with `bun run tests/bench/sources.ts`; the audit
harness merely broadens it to historical schemas, all-null metadata and more
samples without modifying production readers.

## Conditional responses and compression

The machine source endpoint uses a strong, content-derived validator and accepts
`If-None-Match` after bearer, account and scope authorization. Matching requests
return a bodyless 304. Hono's SHA-256 digest middleware folds streamed chunks;
the validator is opaque, not a promise of `SHA256(entireBody)` for large responses.
It saves response transfer, not the source read/projection work needed to establish
the current representation.

An authenticated in-process Hono measurement on the same fixture recorded a full
200 median of 30.810 ms / 593,822 body bytes versus 304 at 29.685 ms / zero body
bytes. Both executed six queries (five reader queries plus authentication). This
uses three warmups and twelve samples; it is not a Worker/network benchmark.

Responses remain `private, no-store`; explicit pollers can retain validators, but
this is not permission for shared caching or a promise of automatic browser body
cache reuse. `Vary: Authorization` and `Referrer-Policy: no-referrer` remain on 200
and 304 responses. Query variants and content changes, including changes without
new timestamps, are represented by the content validator.

Do not manually gzip the response. Cloudflare documents automatic Brotli/Gzip
negotiation in the production Workers runtime. JSON is an eligible content type;
the response remains normal JSON without manual `Content-Encoding` or
`encodeBody:"manual"`. A local gzip size illustration reduces 593,822 bytes to
38,248 bytes, but that is not a deployed wire measurement. Cloudflare can weaken
or remove an ETag when transforming the representation, so consumers must treat
validators as opaque and accept weak request validators. No `no-transform` header
is added to force a strong edge tag at the expense of compression.

Official references checked for this change:

- [Workers Accept-Encoding handling](https://developers.cloudflare.com/workers/runtime-apis/fetch/#how-the-accept-encoding-header-is-handled)
- [Compression eligibility and negotiation](https://developers.cloudflare.com/speed/optimization/content/compression/)
- [Response encodeBody](https://developers.cloudflare.com/workers/runtime-apis/response/#the-encodebody-option)
- [ETag transformations](https://developers.cloudflare.com/cache/reference/etag-headers/)

Zone-specific compression rules and final on-wire ETag/Content-Encoding behavior
remain deployment verification items; local acceptance does not prove those edge
settings. This work does not alter production configuration.
