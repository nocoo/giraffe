# Source Index Performance

## Measurement boundary

The October 2026 consumer report measured about 606 KB / 9.7 s for `/sources`
and 7.3 s with `since`. These production timings are reported symptoms, not
measurements made by this change. No production refresh, D1 query trace or zone
configuration change was performed.

Local profiling uses Bun 1.4.3 on macOS arm64 and the existing in-memory SQLite
test adapter. It executes the production reader against deterministic saved data:
126 repositories, five snapshot resources and seven factory streams per repository,
plus five account sources (1,517 total). Each repository has 40 issues, 30 PRs,
60 Actions runs and 12 releases. The fixture includes old aliases, removed history,
mixed publication versions and incomplete coverage. Its 644 stored snapshot rows
contain 8,784,588 payload bytes. Fake URLs use `github.example`; reads forbid fetch
and verify that saved rows are unchanged.

Each scenario uses three warmups and twelve timed samples. Separate detailed
traces instrument queries, JSON parsing/stringification and digest submission;
their instrumentation overhead is not included in the timing table. This is a
local SQLite/JSC measurement, not deployed D1/V8 or a network-latency simulation.

## Before optimization

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
payload transfer and decoding. No index or schema migration is justified by this
profile.

## After optimization

The request now reads policy once (three queries), reads the publication head
once, then bulk-loads only the needed account/repository pages and selected
publication in one query. Decoded page groups feed both the source index and the
shared account/CI projections. Catalog and publication data are reused; source
time filtering happens before unnecessary content digests. There is no persistent
cache, new dependency, index migration or refresh requirement.

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
content hashing still reflects every actual source; the empty-since case avoids
all 634 previous digests. Full local read time improves about 25%, and empty-since
time about 59%. This does not establish a production latency percentage.

The maintained fixture, query counter and standalone benchmark reproduce the
dataset and structural checks:

```bash
bun run tests/bench/sources.ts
bun run test apps/web/src/server/lib/machine-sources.test.ts
```

The benchmark prints twelve raw samples, median/p95 timing, payload/query counts,
response hashes and separate parsing/stringification/digest measurements for each
scenario. Timing varies with runtime and concurrent load; regression tests enforce
the five-query bound and source/content semantics, not a noisy wall-clock limit.
The machine request's bearer lookup is additional. Volatile rate projection adds
one query only to actual account `/factory` responses, not `/sources` or streams.

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
