import assert from "node:assert/strict";
import { readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(root, "data/solar/panelcensus");
const dataset = JSON.parse(await readFile(resolve(directory, "us-county-solar.json"), "utf8"));
const expectedCodes = "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" ");
assert.deepEqual(dataset.states.map((state) => state.stateCode).sort(), [...expectedCodes].sort());
assert.equal(new Set(dataset.counties.map((county) => county.sourceCountyUrl)).size, dataset.counties.length);
assert.equal(dataset.summary.countyRowCount, dataset.counties.length);
assert.equal(dataset.summary.statesWithCountyTables, 50);

const browser = await chromium.launch();
const context = await browser.newContext();
const results = new Array(50);
let cursor = 0;
try {
  await Promise.all(Array.from({ length: 2 }, async () => {
    const page = await context.newPage();
    while (cursor < dataset.states.length) {
      const index = cursor++, state = dataset.states[index];
      const source = JSON.parse(await readFile(resolve(directory, state.sourceSnapshot), "utf8"));
      const expected = new Map(dataset.counties.filter((county) => county.stateCode === state.stateCode)
        .map((county) => [county.sourceCountyUrl, county]));
      const captured = new Map(source.countyRows.map((row) => [row.countyUrl, row]));
      const response = await page.goto(state.sourceUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      assert.equal(response.status(), 200, `${state.stateCode}: source page must load`);
      const table = page.getByRole("table", { name: `Solar installations by county in ${state.stateName}`, exact: true });
      assert.equal(await table.count(), 1, `${state.stateCode}: one county table`);
      const live = await table.locator("tbody tr").evaluateAll((rows) => rows.map((row) => {
        const cells = [...row.querySelectorAll("td")];
        const link = cells[0].querySelector("a");
        return { cells: cells.map((cell) => cell.textContent.trim()), name: link.textContent.trim(), url: link.href,
          limited: Boolean(cells[0].querySelector('[title="Too few records for reliable medians"]')) };
      }));
      assert.equal(live.length, expected.size, `${state.stateCode}: every published row is included`);
      assert.equal(live.length, state.countyRowCount);
      for (const row of live) {
        const county = expected.get(row.url);
        assert.ok(county, `${state.stateCode}: missing ${row.url}`);
        assert.deepEqual(row.cells, captured.get(row.url)?.cells, `${row.url}: current table matches source capture`);
        assert.equal(row.name, county.countyName);
        assert.equal(Number(row.cells[1].replaceAll(",", "")), county.recordedInstallations);
        assert.equal(row.cells[2], county.homesWithSolarDisplay);
        assert.equal(row.cells[3], county.capacityDisplay);
        assert.equal(row.cells[4], county.medianPriceDisplay);
        assert.equal(row.limited, county.limitedData);
      }
      const currentTotal = await page.locator("main").evaluate((main) => /([\d,]+)\s+recorded installations/
        .exec(main.innerText)?.[1]);
      assert.equal(Number(currentTotal.replaceAll(",", "")), state.stateRecordedInstallations);
      results[index] = { stateCode: state.stateCode, sourceUrl: state.sourceUrl, httpStatus: response.status(),
        countyRowsMatched: live.length, allRowsMatch: true, stateTotalMatches: true, verifiedAt: new Date().toISOString() };
      console.log(`${state.stateCode}: verified all ${live.length} county rows`);
      await page.waitForTimeout(350);
    }
    await page.close();
  }));
} finally { await browser.close(); }

assert.equal(results.filter(Boolean).length, 50);
assert.equal(results.reduce((sum, state) => sum + state.countyRowsMatched, 0), dataset.counties.length);
const report = { verifiedAt: new Date().toISOString(), expectedStateCount: 50, verifiedStateCount: results.length,
  countyRowsMatched: dataset.counties.length,
  scope: "Every exported county row and installation count matched a second browser read of all 50 live state tables; limited rows included. State headline totals verified independently.",
  states: results };
const path = resolve(directory, "verification.json");
await writeFile(`${path}.tmp`, JSON.stringify(report, null, 2) + "\n");
await rename(`${path}.tmp`, path);
console.log(JSON.stringify({ verifiedStates: report.verifiedStateCount, matchedCountyRows: report.countyRowsMatched }));
