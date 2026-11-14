import { Bundler, Runtime, parseArgs } from "@vistta/cli";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright-chromium";
import { run } from "../index.js";

const exec = promisify(execFile);
const packagePath = fileURLToPath(new URL("../", import.meta.url));

class BrowserBundler extends Bundler {
  constructor() {
    super(new Runtime({ resolvers: ["js"] }));
  }
}

describe("browser runner", { concurrency: false }, () => {
  let state;

  beforeEach(async (context) => {
    assert.ok("after" in context && "mock" in context, "Expected a per-test context");
    const cwd = process.cwd();
    const nodeEnv = process.env.NODE_ENV;
    const nodeDebug = process.env.NODE_DEBUG;
    const exitCode = process.exitCode;
    const directory = await mkdtemp(join(tmpdir(), "vistta-testing-"));
    state = {
      directory,
      file: join(directory, "example.test.js"),
      pages: [],
      results: [{ name: "Example", tests: [{ name: "works", status: "pass", start: 1, end: 2 }] }],
    };
    await writeFile(state.file, "");
    delete process.env.NODE_DEBUG;
    process.exitCode = 0;
    context.after(async () => {
      context.mock.restoreAll();
      process.chdir(cwd);
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
      if (nodeDebug === undefined) delete process.env.NODE_DEBUG;
      else process.env.NODE_DEBUG = nodeDebug;
      process.exitCode = exitCode;
      await rm(directory, { recursive: true, force: true });
    });
    state = {
      ...state,
      output: context.mock.method(console, "print", () => {}),
      error: context.mock.method(console, "error", () => {}),
      log: context.mock.method(console, "log", () => {}),
      close: context.mock.fn(async () => {}),
      launch: context.mock.method(chromium, "launch", async () => ({
        close: state.close,
        async newPage() {
          const page = {
            async route() {},
            async goto() {},
            on(event, callback) {
              if (event === "pageerror") this.pageError = callback;
            },
            async exposeBinding(name, callback) {
              assert.equal(name, "visttaSend");
              this.send = callback;
            },
            async addScriptTag({ content }) {
              this.options = JSON.parse(content.split("\n")[0].slice("globalThis.testOptions = ".length, -1));
              if (state.pageError) {
                this.pageError(new Error("page crashed"));
                await new Promise((resolve) => setImmediate(resolve));
              } else if (state.scriptError) {
                throw new Error("script injection failed");
              } else if (state.testError) {
                await this.send(null, "test-error", "renderer failed");
              } else {
                await this.send(null, "console", { level: "log", args: ["browser output"] });
                await this.send(null, "test-results", state.results);
              }
            },
            close: context.mock.fn(async () => {}),
          };
          state.pages.push(page);
          return page;
        },
      })),
      Bundler: class {
        async run(entry, options) {
          assert.equal(process.env.NODE_ENV, "testing");
          if (options.globalName) {
            assert.equal(process.cwd(), dirname(entry));
            if (state.bundleError) throw new Error("bundle failed");
          }
          return { code: "" };
        }
      },
      run: (...args) => run([state.file, ...args], { Bundler: state.Bundler, parseArgs }),
    };
  });

  test("debug flag launches headed, forwards console and reaches the renderer", async () => {
    await state.run("--debug");
    assert.equal(state.launch.mock.calls[0].arguments[0].headless, false);
    assert.equal(state.pages[0].options.debug, true);
    assert.equal(state.log.mock.calls[0].arguments[0], "browser output");
    assert.equal(process.exitCode, 0);
  });

  test("default run is headless and forwards filter and only without console output", async () => {
    await state.run("--filter=works", "--only");
    assert.equal(state.launch.mock.calls[0].arguments[0].headless, true);
    assert.deepEqual(state.pages[0].options, { filter: "works", only: true, debug: false });
    assert.equal(state.log.mock.callCount(), 0);
  });

  test("legacy NODE_DEBUG enables debug mode", async () => {
    process.env.NODE_DEBUG = "true";
    await state.run();
    assert.equal(state.launch.mock.calls[0].arguments[0].headless, false);
    assert.equal(state.pages[0].options.debug, true);
  });

  test("explicit false does not enable debug mode", async () => {
    await state.run("--debug=false");
    assert.equal(state.launch.mock.calls[0].arguments[0].headless, true);
  });

  test("unmatched globs fail without launching a browser", async () => {
    await run([join(state.directory, "missing-*.js")], { Bundler: state.Bundler, parseArgs });
    assert.equal(process.exitCode, 1);
    assert.match(state.error.mock.calls[0].arguments[0], /No test files found/);
    assert.equal(state.launch.mock.callCount(), 0);
  });

  test("node_modules matches are excluded", async () => {
    const dependency = join(state.directory, "node_modules");
    await mkdir(dependency);
    await writeFile(join(dependency, "ignored.test.js"), "");
    await run([join(state.directory, "**/*.test.js")], { Bundler: state.Bundler, parseArgs });
    assert.equal(state.pages.length, 1);
    assert.equal(process.exitCode, 0);
  });

  test("each file gets a fresh page and all pages close", async () => {
    await writeFile(join(state.directory, "second.test.js"), "");
    await run([join(state.directory, "*.test.js")], { Bundler: state.Bundler, parseArgs });
    assert.equal(state.pages.length, 2);
    for (const page of state.pages) assert.equal(page.close.mock.callCount(), 1);
    assert.equal(state.close.mock.callCount(), 1);
  });

  test("failed tests set exit code 1 and print the failure", async () => {
    state.results[0].tests[0].status = "fail";
    state.results[0].tests[0].error = "expected failure";
    await state.run();
    assert.equal(process.exitCode, 1);
    assert.match(state.output.mock.calls[0].arguments[0], /FAILED.*works/);
    assert.match(state.output.mock.calls[0].arguments[0], /0\/1 passing/);
  });

  for (const failure of ["bundleError", "pageError", "scriptError", "testError"]) {
    test(`${failure} fails the file and closes resources`, async () => {
      state[failure] = true;
      await state.run();
      assert.equal(process.exitCode, 1);
      assert.equal(state.error.mock.callCount(), 1);
      assert.equal(state.pages[0].close.mock.callCount(), 1);
      assert.equal(state.close.mock.callCount(), 1);
    });
  }

  test("working directory and existing NODE_ENV are restored", async () => {
    const cwd = process.cwd();
    process.env.NODE_ENV = "development";
    await state.run();
    assert.equal(process.cwd(), cwd);
    assert.equal(process.env.NODE_ENV, "development");
  });

  test("an originally absent NODE_ENV is removed again", async () => {
    delete process.env.NODE_ENV;
    await state.run();
    assert.equal(process.env.NODE_ENV, undefined);
  });

  test("launch failure preserves process state", async () => {
    const cwd = process.cwd();
    process.env.NODE_ENV = "development";
    state.launch.mock.mockImplementation(async () => {
      throw new Error("launch failed");
    });
    await assert.rejects(state.run(), /launch failed/);
    assert.equal(process.cwd(), cwd);
    assert.equal(process.env.NODE_ENV, "development");
  });

  test("browser close failure still restores process state", async () => {
    const cwd = process.cwd();
    process.env.NODE_ENV = "development";
    state.close.mock.mockImplementation(async () => {
      throw new Error("close failed");
    });
    await assert.rejects(state.run(), /close failed/);
    assert.equal(process.cwd(), cwd);
    assert.equal(process.env.NODE_ENV, "development");
  });

  test("real Chromium executes the renderer and DOM assertions", { timeout: 60000 }, async () => {
    state.launch.mock.restore();
    await writeFile(
      state.file,
      `suite("Browser smoke", () => {
      test("real DOM", async () => {
        expect(isSecureContext).toEqual(true);
        expect(typeof crypto.randomUUID()).toEqual("string");
        expect(typeof navigator.storage.getDirectory).toEqual("function");
        expect((await navigator.storage.getDirectory()).kind).toEqual("directory");
        document.body.innerHTML = '<input id="value" value="ready">';
        expect(document.querySelector("#value").value).toEqual("ready");
      });
    });`,
    );
    await run([state.file], { Bundler: BrowserBundler, parseArgs });
    assert.equal(process.exitCode, 0);
    assert.match(state.output.mock.calls[0].arguments[0], /1\/1 passing/);
  });

  test("real subprocess exits 1 on a failed assertion", { timeout: 60000 }, async () => {
    await writeFile(state.file, 'suite("Failure smoke", () => test("fails", () => expect(1).toEqual(2)));');
    const script = `import { run } from "./index.js";
      import { Bundler, Runtime, parseArgs } from "@vistta/cli";
      class BrowserBundler extends Bundler {
        constructor() { super(new Runtime({ resolvers: ["js"] })); }
      }
      await run([process.argv[1]], { Bundler: BrowserBundler, parseArgs });`;
    await assert.rejects(
      exec(process.execPath, ["--input-type=module", "--eval", script, state.file], {
        cwd: packagePath,
        timeout: 45000,
      }),
      (error) => {
        assert.ok(
          error instanceof Error &&
            "code" in error &&
            "stderr" in error &&
            typeof error.stderr === "string" &&
            "stdout" in error &&
            typeof error.stdout === "string",
          "Expected a subprocess execution error",
        );
        assert.equal(error.code, 1, error.stderr || error.stdout);
        assert.match(error.stdout, /FAILED.*fails/);
        assert.match(error.stdout, /0\/1 passing/);
        return true;
      },
    );
  });
});
