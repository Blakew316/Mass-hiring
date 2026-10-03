# Speed measurements

Made-up data only. Nothing here is deployed.

    npm install --prefix /some/dir playwright-core      # once, outside the repo
    ROOT=<repo copy> node tests/perf/fixture.js /some/dir/fixture   # a 32,667-person team
    PLAYWRIGHT_CORE=/some/dir/node_modules/playwright-core FIXTURE=/some/dir/fixture \
      ROOT=<repo copy> PORT=3810 node tests/perf/bench.js > result.json

`fixture.js` and `bench.js` wipe `ROOT/data`. Run them against a copy of the
repo, never one whose data matters. Compare only runs made the same way on
the same machine, base and change interleaved.
