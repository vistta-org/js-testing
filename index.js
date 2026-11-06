import { COLORS } from "@vistta/console";
import "@vistta/console/global";
import fs from "@vistta/fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-chromium";

const rendererPath = fileURLToPath(import.meta.resolve("@vistta/js/testing/renderer"));

export async function run(argv = [], { Bundler, parseArgs }) {
  const cwd = process.cwd();
  const [patterns, options] = parseArgs(argv);
  const debug = options.debug === true || options.debug === "true" || process.env.NODE_DEBUG === "true";
  const args = patterns.length ? patterns : ["**/*.test.js", "**/*.test.ts", "**/*.test.jsx", "**/*.test.tsx"];
  const entries = [];
  // @ts-ignore
  for await (const entry of fs.glob(args.map((pattern) => fs.resolve(cwd, pattern)))) {
    if (!entry.includes("\\node_modules\\") && !entry.includes("/node_modules/")) entries.push(entry);
  }
  if (!entries.length) {
    console.error(`No test files found for: ${args.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  const bundler = new Bundler();
  const results = [];
  const nodeEnv = process.env.NODE_ENV;
  let failed = false;
  let browser;

  process.env.NODE_ENV = "testing";
  try {
    browser = await chromium.launch({ headless: !debug });
    const renderer = await bundler.run(rendererPath, {
      write: false,
      platform: "browser",
      format: "iife",
    });
    for (const entry of entries) {
      const page = await browser.newPage();
      try {
        await page.route("http://vistta.test/**", (route) =>
          route.fulfill({ contentType: "text/html", body: "<!doctype html><html><head></head><body></body></html>" }),
        );
        await page.goto("http://vistta.test/");
        let test;
        try {
          process.chdir(fs.dirname(entry));
          test = await bundler.run(fs.resolve(entry), {
            write: false,
            platform: "browser",
            globalName: "main",
            format: "iife",
          });
        } finally {
          process.chdir(cwd);
        }
        let resolveResult;
        let rejectResult;
        const outcome = new Promise((resolve, reject) => {
          resolveResult = resolve;
          rejectResult = reject;
          page.on("pageerror", reject);
        });
        await page.exposeBinding("visttaSend", (_, event, payload) => {
          if (event === "test-results") resolveResult(payload);
          if (event === "test-error") rejectResult(new Error(payload));
          if (event === "console" && debug) console[payload.level]?.(...payload.args);
        });
        const [, result] = await Promise.all([
          page.addScriptTag({
            content: `globalThis.testOptions = ${JSON.stringify({ ...options, debug })};\nglobalThis.ipc = { send: (...args) => globalThis.visttaSend(...args) };\n${renderer.code}\n${test.code}`,
          }),
          outcome,
        ]);
        results.push(...result);
      } catch (error) {
        console.error(entry, error?.stack || String(error));
        failed = true;
      } finally {
        await page.close();
      }
    }
  } finally {
    try {
      await browser?.close();
    } finally {
      process.chdir(cwd);
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
    }
  }

  let output = "";
  for (const { name, tests } of results) {
    let passing = 0;
    let total = 0;
    let first, last;
    if (name) output += `\n${name}\n`;
    for (const { name, status, start, end, result, error } of tests || []) {
      if (!first || start < first) first = start;
      if (!last || end > last) last = end;
      switch (status) {
        case "pass":
          output += `  ${COLORS.GREEN}PASSED  ${name} ${COLORS.RESET + COLORS.DIM}(${Math.round(end - start)}ms)${COLORS.RESET}\n${typeof result === "string" ? "\t" + COLORS.GREEN + result + COLORS.RESET + "\n" : ""}`;
          passing++;
          total++;
          break;
        case "fail":
          output += `  ${COLORS.RED}FAILED  ${name} ${COLORS.RESET + COLORS.DIM}(${Math.round(end - start)}ms)${COLORS.RESET}\n\t${COLORS.RED + error + COLORS.RESET}\n`;
          total++;
          break;
        case "skip":
          output += `  ${COLORS.YELLOW}SKIPPED ${name} ${COLORS.RESET + COLORS.DIM}(${Math.round(end - start)}ms)${COLORS.RESET}\n`;
          break;
      }
    }
    if (total !== passing) failed = true;
    output += `${passing === total ? COLORS.GREEN : COLORS.RED}${passing}/${total} passing ${COLORS.RESET + COLORS.DIM}(${Math.round(last - first)}ms)${COLORS.RESET}\n`;
  }
  console.print(output);
  if (failed) process.exitCode = 1;
}
