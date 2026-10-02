# @vistta/js-testing

Headless Chromium test runner for `@vistta/js` projects. Install it once in your project:

```sh
npm install -D @vistta/js-testing
```

Then run `npx vistta test` (optionally with test file patterns, `--filter="pattern"`, or `--only`).
Use `--debug` to show the browser while testing.

`playwright-chromium` downloads Chromium during installation. Install scripts must be enabled;
on Linux, Chromium may also require additional system libraries.