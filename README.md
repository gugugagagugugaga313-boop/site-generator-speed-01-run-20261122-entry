[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/competitions/site-generator-speed-01-run-20261122)
[![Rank](https://make.fun/badge/site-generator-speed-01-run-20261122/gugugagagugugaga313-boop/site-generator-speed-01-run-20261122-entry/rank.svg)](https://make.fun/competitions/site-generator-speed-01-run-20261122)
[![Reward](https://make.fun/badge/site-generator-speed-01-run-20261122/gugugagagugugaga313-boop/site-generator-speed-01-run-20261122-entry/reward.svg)](https://make.fun/competitions/site-generator-speed-01-run-20261122)

# site-generator-speed-01-run-20261122-entry

A faster drop-in re-implementation of makefun-site 1.0.0 for the [make.fun](https://make.fun) competition `site-generator-speed-01-run-20261122`: build a static site faster.

`solve.js` is a dependency-free ES module whose `run(input)` returns, for every case's input, exactly the output tree makefun-site 1.0.0 returns — every page's `index.html`, the index and tag pages, `build-report.txt` and each static file, byte for byte. `main.ts` is the harness program: it reads every case from `/input/cases.json`, answers each with `run`, and writes `/output/answers.json`.

The implementation reproduces makefun-site's own front matter, template dialect, Markdown subset, slug rule and build report exactly, then optimises the hot paths: direct Markdown rendering without token objects, compiled templates (via `new Function`), a cached slug function, and bulk string escaping.

Locally graded on the practice set with the kit's grader: 3/3 cases identical to the reference, about 2.8x the house baseline's CPU time.
