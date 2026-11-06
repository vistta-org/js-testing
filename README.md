# @vistta/js-testing

Headless browser test runner for **Vistta JS** — runs `*.test.{js,ts,jsx,tsx}` files in headless Chromium (Playwright), with the Vistta test globals (`suite`, `test`, `expect`, `document.mount`) injected by the `@vistta/js` renderer.

## Features

- **Real browser environment** — tests execute in Chromium (`playwright-chromium`) against the real DOM, not a Node emulation
- **Framework globals injected** — `suite`, `test`, `expect`, `document.mount`, `document.wait`, and a read-only `window.vistta` namespace, provided by the `@vistta/js` test renderer (`@vistta/js/testing/renderer`)
- **Realistic interaction helpers** — `HTMLElement.write()` types into inputs character-by-character with keyboard/input/change events; `click()` is patched so reactive updates settle between interactions
- **Glob-based discovery** — default patterns `**/*.test.{js,ts,jsx,tsx}`, custom patterns as positional arguments, `node_modules` entries skipped, one fresh page per test file
- **Filtering & focus modes** — `--filter` (case-insensitive regex on test names), `--only` (only `.only` tests/suites), `--debug` (headed browser, forwarded `console`, fast `requestAnimationFrame`)
- **Colored terminal report** — per-test `PASSED` / `FAILED` / `SKIPPED` lines with durations, per-suite `n/n passing` summary, exit code `1` on any failure

## Requirements

- Node.js `>= 22`
- `@vistta/js` (peer dependency) — provides the test renderer and the `vistta test` command
- `@vistta/cli` — provides the `Bundler` and `parseArgs` that `run()` uses (wired in automatically by the `vistta test` command)

## Installation

```bash
npm install -D @vistta/js-testing
```

The `vistta test` command is registered by `@vistta/js` (via `"extends": "@vistta/js/config"` in your `tsconfig.json` / `jsconfig.json`) and delegates to this package. If the package is missing, the command fails with an install hint.

## Quick Start

Write a component:

`src/counter.jsx`

```jsx
import { Component } from "@vistta/js";

export default class Counter extends Component {
  count = 0;
  render() {
    return (
      <>
        <span id="output">{this.count}</span>
        <button id="increment" onClick={() => this.count++}>
          increment
        </button>
      </>
    );
  }
}
```

Write a test file (the default patterns pick up `*.test.jsx`):

`src/counter.test.jsx`

```jsx
import Counter from "./counter.jsx";

suite("Counter", async () => {
  await test("increments on click", async () => {
    await document.mount(Counter);
    expect(document.querySelector("#output").innerText).toEqual("0");
    await document.querySelector("#increment").click();
    expect(document.querySelector("#output").innerText).toEqual("1");
  });
});
```

`suite`, `test`, and `expect` are globals inside test files — no imports needed.

Run:

```bash
npx vistta test
```

```text
Counter
  PASSED  increments on click (203ms)
  1/1 passing (203ms)
```

## CLI

```bash
# All tests matching the default patterns
npx vistta test

# Custom glob patterns (positional, resolved against the current directory)
npx vistta test src/**/*.test.jsx

# Explicit runner selection (one environment per invocation)
npx vistta test ".\packages\js\tests\client.test.jsx" --environment=browser
npx vistta test ".\packages\cli\tests\*.test.js" --environment=node

# Only tests whose name matches (case-insensitive regex)
npx vistta test --filter="counter"

# Only tests/suites marked .only
npx vistta test --only

# Headed Chromium, forwarded console, fast requestAnimationFrame
npx vistta test --debug
```

| Option          | Default                                                          | Description                                                                                                      |
| --------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| patterns        | `**/*.test.js`, `**/*.test.ts`, `**/*.test.jsx`, `**/*.test.tsx` | Glob patterns of test files to run                                                                               |
| `--filter`      | –                                                                | Case-insensitive regex; only tests whose name matches run                                                        |
| `--only`        | –                                                                | Only tests (or tests inside suites) marked `.only` run                                                           |
| `--debug`       | –                                                                | Headed browser, page `console` forwarded to the terminal, `requestAnimationFrame` shimmed to `setTimeout(cb, 1)` |
| `--environment` | `browser` with VISTTA JS                                         | `node` or `browser`; selects the runner before test files are loaded                                             |

The environment flag belongs only to the `@vistta/js` test command, not to
individual suites or the built-in `@vistta/cli` command. The browser remains the
default with `@vistta/js/config`; selecting Node delegates to the unchanged,
Node-only `@vistta/cli` test command. Select compatible files explicitly. Imports
and suite declarations do not change, and mixed-environment collections are not
automatically split.

The exit code is `0` when every test passes and `1` when any test fails, a test file fails to load, or no test files match (after excluding `node_modules`). Empty discovery prints `No test files found` without launching Chromium.

`NODE_DEBUG=true` is also supported as a legacy way to enable debug mode.

## How It Works

1. Matching test files are discovered. `process.env.NODE_ENV` is temporarily set to `"testing"` and Chromium is launched (headless unless `--debug` or `NODE_DEBUG=true`).
2. The renderer is resolved from `@vistta/js/testing/renderer` and bundled for the browser (`platform: "browser"`, IIFE).
3. Test files are discovered with the glob patterns (relative to the current directory); `node_modules` entries are skipped.
4. Each test file gets a fresh page routed at `http://vistta.test/` (fulfilled with a blank HTML document). The working directory changes to the test file's folder only while it is bundled (so relative imports resolve) and is restored afterwards. The original `NODE_ENV` is restored when the run finishes, including on failure.
5. The renderer, the bundled test file, `testOptions`, and an `ipc` shim are injected in one script tag. The renderer registers the globals, patches the DOM helpers, runs all suites, and sends the results back over the exposed `visttaSend` binding (`test-results` / `test-error`). Uncaught page errors fail the file's run.
6. The runner prints the colored report and sets the exit code.

## Test API

Globals available inside test files (injected by the renderer):

### `suite(name, callback)`

Registers a suite. The callback runs once; tests registered inside it run concurrently. Suites cannot be nested.

- `suite.only(name, callback)` — mark the suite for `--only`
- `suite.skip(name, callback)` — skip every test in the suite

### `test(name, callback)`

Registers a test. The (async) callback's resolved value is the test result — a `string` result is printed under the `PASSED` line; a throw/rejection fails the test and the error is printed.

- `test.only(name, callback)` — mark the test for `--only`
- `test.skip(name, callback)` — skip the test (shown as `SKIPPED`, not counted in the total)

### `expect(target, label?)`

Assertion helper:

| Matcher                         | Checks                                           |
| ------------------------------- | ------------------------------------------------ |
| `toEqual(value, unit?)`         | strict equality (`===`)                          |
| `toBeLessThan(value, unit?)`    | `target < value`                                 |
| `toBeGreaterThan(value, unit?)` | `target > value`                                 |
| `toInclude(value)`              | `target` contains `value`                        |
| `toMatch(regex)`                | `target` matches the regex                       |
| `toThrow(message?)`             | `target()` throws (exact or regex message match) |

Every matcher is also available negated: `expect(target).not.<matcher>`.

> `toEqual` is **strict** equality — compare objects with `toInclude` / `toMatch` on a serialized form instead.

### `document.mount(component, props?, config?)`

Mounts a component (class or function) into `document.body` via the framework `VirtualDom`, unmounting any previously mounted tree first. Waits ~100 ms before and after rendering so effects and layout settle. Returns the `VirtualDom` handle.

```jsx
await document.mount(Counter);
```

### `document.wait(ms)`

Sleep helper: `await document.wait(500)`.

### `element.write(text, options?)`

Patched onto `HTMLElement.prototype`. Types `text` into an input/textarea one character at a time, dispatching `keydown` / `keypress` / `input` / `keyup` per character and a final `change` event:

| Option                   | Default | Description                               |
| ------------------------ | ------- | ----------------------------------------- |
| `delay`                  | `100`   | Delay (ms) between characters             |
| `clear`                  | `false` | Clear `value` before typing               |
| `dispatchKeyboardEvents` | `true`  | Dispatch `keydown` / `keypress` / `keyup` |

Throws if the target has no `value` property.

```jsx
await document.querySelector("#input").write("12345!", { clear: true });
```

### `element.click()`

Patched onto `HTMLElement.prototype` to be `async` — sleeps ~100 ms before and after the native click so reactive updates settle. Always `await` it in tests.

### `window.vistta`

Read-only namespace with the framework surface for tests: `Fragment`, `Element`, `Context`, `Ref`, `Mutation`, `Component`, `Suspense`, `VirtualContainer`, `Profiler`, `Render`, `Safe`, `Form`, `router`, `socket`, `Anchor`, `File`, `HistoryContext`, `Style`, `ThemeContext`.

`window.platform` is set to `"desktop"` for the test run.

### Console

Page `console.*` calls are forwarded to the runner over ipc and printed to the terminal when `--debug` is set (they always print in the page).

## Programmatic API

### `run(argv, { Bundler, parseArgs })`

Runs the tests — this is what the `vistta test` command calls. You can call it directly:

```js
import { run } from "@vistta/js-testing";
import { Bundler, parseArgs } from "@vistta/cli";

await run(["src/**/*.test.jsx", "--only"], { Bundler, parseArgs });
```

- `argv` — array of CLI arguments (positional glob patterns + `--` options)
- `Bundler` — the `@vistta/cli` bundler class (a CLI `Command` instance also works)
- `parseArgs` — the `@vistta/cli` argument parser

Sets `process.exitCode = 1` when tests fail.

The bundler must have the loaders and extension resolvers required by your project configured; the CLI supplies these automatically. Runs temporarily change process-wide working directory and environment state. Do not invoke multiple runs concurrently in the same process, or combine a run with other work that depends on those globals. Use separate processes for parallel runs.

## Security

Run only trusted test files and dependencies. Test modules are bundled in the Node process and execute with normal browser capabilities. The `vistta.test` route supplies the test document; it does not block requests to other hosts or sandbox network access. The bundler can inline environment variables referenced by browser code. Do not run untrusted tests with credentials or sensitive environment variables, and use an isolated environment with restricted network access when needed. Debug mode also prints browser console output, which may contain sensitive test data.

## Development Validation

From this package directory:

```bash
npm test
npm pack --dry-run --ignore-scripts
```

The Node test suite covers debug options, discovery, failure reporting, process-state restoration, and resource cleanup. It also executes the actual renderer in Chromium and checks failing-test exit codes in a separate process. It requires the workspace development dependencies and the `@vistta/js` peer. On Linux CI, install Chromium and its system libraries before running the suite:

```bash
npx playwright install --with-deps chromium
```

The release workflow starts from `0.0.0` and uses a Patch release to publish `0.0.1`. Coordinate publication with `@vistta/js@0.0.1` or a compatible newer peer; the local workspace peer is still `0.0.0` until its own release.

## License

Licensed under the GNU General Public License version 3 only (`GPL-3.0-only`). See [LICENSE](LICENSE) for the full terms.

## Contributing

Thank you for your interest in contributing to this project! Please ensure that any contributions respect the licensing terms specified. If you encounter any issues or have suggestions, feel free to report them. All issues will be well received and addressed to the best of our ability. We appreciate your support and contributions!

### **Authors**

- [Tiago Terenas Almeida](https://github.com/tiagomta)
