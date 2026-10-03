# Speed measurements

Made-up data only. Nothing here is deployed.

    npm install --prefix /some/dir playwright-core      # once, outside the repo
    ROOT=<repo copy> node tests/perf/fixture.js /some/dir/fixture   # a 32,667-person team
    PLAYWRIGHT_CORE=/some/dir/node_modules/playwright-core FIXTURE=/some/dir/fixture \
      ROOT=<repo copy> PORT=3810 node tests/perf/bench.js > result.json

`fixture.js` and `bench.js` wipe `ROOT/data`. Run them against a copy of the
repo, never one whose data matters. Compare only runs made the same way on
the same machine, base and change interleaved.

The server alone, route by route (no browser):

    FIXTURE=/some/dir/fixture ROOT=<repo copy> PORT=3820 [BLOB_MS=40] node tests/perf/routes.js > routes.json

`BLOB_MS` (for routes.js and bench.js; `blobMs` for serve.js) keeps the data
in `fake-blobs.js`, an in-memory stand-in for Netlify Blobs that answers as
the real store does (ETags, a 304 for a read naming the current one) and
waits that many milliseconds per call plus the transfer time; without it the
data is local files. Run the same script against both copies: the stand-in is
put in place below the app, so it measures old and new code the same way.
