# Development and compatibility

Development checks target Pi **1.5.0**, with the host packages pinned in
`devDependencies`. Wildcard peer dependencies follow Pi's host-module contract;
they are not a claim that every historical Pi release supports every feature.
The old `>=0.74.0` peer range did not cover all lifecycle events now used.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check  # strict source and test checks against real host types
npm test      # Node test runner, including compositor/lifecycle regressions
```

`bun.lock` is the canonical development lockfile. Commit it after changing
dependencies. Runtime Pi installations supply the host modules themselves.
