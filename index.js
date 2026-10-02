import { COLORS } from "@vistta/console";
import "@vistta/console/global";
import fs from "@vistta/fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-chromium";

const rendererPath = fileURLToPath(import.meta.resolve("@vistta/js/testing/renderer"));

export async function run(argv = [], { Bundler, parseArgs }) {
  const cwd = process.cwd();
  const [patterns, options] = parseArgs(argv);
  const args = patterns.length ? patterns : ["**/*.test.js", "**/*.test.ts", "**/*.test.jsx", "**/*.test.tsx"];
  const entries = fs.glob(args.map((pattern) => fs.resolve(cwd, pattern)));
  const bundler = new Bundler();
  const results = [];
  let failed = false;
  let browser;

  process.env.NODE_ENV = "testing";
  try {
    browser = await chromium.launch({ headless: process.env.NODE_DEBUG !== "true" });
    const renderer = await bundler.run(rendererPath, {
      write: false,
      platform: "browser",
      format: "iife",
    });
    let entry = (await entries.next())?.value;
    while (entry) {
      if (!entry.includes("\\node_modules\\") && !entry.includes("/node_modules/")) {
        const page = await browser.newPage();
        try {
          await page.route("http://vistta.test/**", (route) =>
            route.fulfill({ contentType: "text/html", body: "<!doctype html><html><head></head><body></body></html>" }),
          );
          await page.goto("http://vistta.test/");
          process.chdir(fs.dirname(entry));
          const test = await bundler.run(fs.resolve(entry), {
            write: false,
            platform: "browser",
            globalName: "main",
            format: "iife",
          });
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
            if (event === "console" && process.env.NODE_DEBUG === "true") console[payload.level]?.(...payload.args);
          });
          await page.addScriptTag({
            content: `globalThis.testOptions = ${JSON.stringify({ ...options, debug: process.env.NODE_DEBUG === "true" })};\nglobalThis.ipc = { send: (...args) => globalThis.visttaSend(...args) };\n${renderer.code}\n${test.code}`,
          });
          results.push(...(await outcome));
        } catch (error) {
          console.error(entry, error?.stack || String(error));
          failed = true;
        } finally {
          await page.close();
        }
      }
      entry = (await entries.next())?.value;
    }
  } finally {
    await browser?.close();
    process.chdir(cwd);
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
