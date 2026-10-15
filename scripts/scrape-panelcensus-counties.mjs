import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(root, "data/solar/panelcensus");
const sourcesDirectory = resolve(directory, "sources");
const resume = process.argv.includes("--resume");
if (process.argv.slice(2).some((arg) => arg !== "--resume")) throw new Error("Usage: npm run scrape:solar-counties -- [--resume]");
const states = [
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"], ["CA", "California"],
  ["CO", "Colorado"], ["CT", "Connecticut"], ["DE", "Delaware"], ["FL", "Florida"], ["GA", "Georgia"],
  ["HI", "Hawaii"], ["ID", "Idaho"], ["IL", "Illinois"], ["IN", "Indiana"], ["IA", "Iowa"],
  ["KS", "Kansas"], ["KY", "Kentucky"], ["LA", "Louisiana"], ["ME", "Maine"], ["MD", "Maryland"],
  ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"], ["MS", "Mississippi"], ["MO", "Missouri"],
  ["MT", "Montana"], ["NE", "Nebraska"], ["NV", "Nevada"], ["NH", "New Hampshire"], ["NJ", "New Jersey"],
  ["NM", "New Mexico"], ["NY", "New York"], ["NC", "North Carolina"], ["ND", "North Dakota"], ["OH", "Ohio"],
  ["OK", "Oklahoma"], ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"], ["SC", "South Carolina"],
  ["SD", "South Dakota"], ["TN", "Tennessee"], ["TX", "Texas"], ["UT", "Utah"], ["VT", "Vermont"],
  ["VA", "Virginia"], ["WA", "Washington"], ["WV", "West Virginia"], ["WI", "Wisconsin"], ["WY", "Wyoming"],
].map(([code, name]) => ({ code, name, slug: name.toLowerCase().replaceAll(" ", "-") }));
const expectedHeaders = ["County", "Installs", "% homes", "Capacity", "Median $/W"];

async function atomic(path, value) {
  await writeFile(`${path}.tmp`, value);
  await rename(`${path}.tmp`, path);
}

function numeric(display, type) {
  if (/^(?:—|–|-|N\/A)?$/.test(display.trim())) return null;
  const text = display.replaceAll(",", "").trim();
  const pattern = type === "count" ? /^\d+$/ : type === "percent" ? /^([\d.]+)%$/ : /^\$([\d.]+)\/W$/;
  const match = pattern.exec(text);
  if (!match) throw new Error(`Unexpected ${type} value: ${display}`);
  const value = Number(type === "count" ? match[0] : match[1]);
  if (!Number.isFinite(value) || value < 0 || (type === "count" && !Number.isSafeInteger(value)))
    throw new Error(`Invalid ${type} value: ${display}`);
  return value;
}

function capacity(display) {
  if (/^(?:—|–|-)?$/.test(display.trim())) return null;
  const match = /^([\d,.]+)\s*(GW|MW|kW|W)$/.exec(display.trim());
  if (!match) throw new Error(`Unexpected capacity: ${display}`);
  return Number((Number(match[1].replaceAll(",", "")) * { GW: 1e6, MW: 1e3, kW: 1, W: 0.001 }[match[2]]).toFixed(6));
}

await mkdir(sourcesDirectory, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext();
const sources = new Array(states.length);
let cursor = 0;
try {
  await Promise.all(Array.from({ length: 2 }, async () => {
    const page = await context.newPage();
    while (cursor < states.length) {
      const index = cursor++, state = states[index];
      const path = resolve(sourcesDirectory, `${state.slug}.json`);
      if (resume) {
        try {
          const existing = JSON.parse(await readFile(path, "utf8"));
          if (existing.state.code === state.code && existing.httpStatus === 200 && existing.heading === `Solar installations in ${state.name}`) {
            sources[index] = existing;
            console.log(`${state.code}: reused ${existing.countyRows.length} county rows`);
            continue;
          }
        } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      const url = `https://panelcensus.com/solar/${state.slug}`;
      let source;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
          await page.waitForFunction((name) => document.querySelector("h1")?.textContent.trim() === `Solar installations in ${name}`,
            state.name, { timeout: 20000 });
          // Read every DOM row, including rows hidden by the limited-data checkbox.
          source = await page.evaluate(() => {
            const main = document.querySelector("main");
            const mainText = main.innerText.replace(/\s+/g, " ").trim();
            const table = [...main.querySelectorAll("table")].find((table) => table.querySelector("th")?.textContent.trim() === "County");
            const section = table?.closest("section");
            return {
              heading: main.querySelector("h1").textContent.trim(), documentTitle: document.title,
              datasetUpdated: /Dataset updated\s+([A-Za-z]+\s+\d{4})/.exec(mainText)?.[1] || null,
              stateInstallationsDisplay: /([\d,]+)\s+recorded installations/.exec(mainText)?.[1] || null,
              stateCapacityDisplay: /Total capacity\s*([\d.,]+\s*(?:GW|MW|kW|W))/.exec(mainText)?.[1] || null,
              underReported: mainText.includes("is under-reported"),
              countyTablePresent: Boolean(table), countyTableHeading: section?.querySelector("h2")?.textContent.trim() || null,
              countyHeaders: table ? [...table.querySelectorAll("thead th")].map((cell) => cell.textContent.trim()) : [],
              countyRows: table ? [...table.querySelectorAll("tbody tr")].map((row) => {
                const cells = [...row.querySelectorAll("td")];
                const link = cells[0]?.querySelector("a");
                return { cells: cells.map((cell) => cell.textContent.trim()), countyName: link?.textContent.trim() || null,
                  countyUrl: link?.href || null, limitedData: [...(cells[0]?.querySelectorAll("span") || [])].some((span) => span.textContent.trim() === "limited"),
                  hiddenAtScrape: getComputedStyle(row).display === "none" || row.hidden };
              }) : [],
            };
          });
          const html = await page.content();
          source = { state, sourceUrl: url, httpStatus: response.status(), scrapedAt: new Date().toISOString(),
            renderedHtmlSha256: createHash("sha256").update(html).digest("hex"), ...source };
          if (source.httpStatus !== 200) throw new Error(`${state.code}: HTTP ${source.httpStatus}`);
          break;
        } catch (error) {
          if (attempt === 2) throw error;
          await page.waitForTimeout((attempt + 1) * 3000);
        }
      }
      await atomic(path, JSON.stringify(source, null, 2) + "\n");
      sources[index] = source;
      console.log(`${state.code}: ${source.countyRows.length} county rows${source.countyTablePresent ? "" : " (county table not published)"}`);
      await page.waitForTimeout(350);
    }
    await page.close();
  }));
} finally { await browser.close(); }

const counties = [], summaries = [], countyIds = new Set();
for (const source of sources) {
  if (source.countyTablePresent && JSON.stringify(source.countyHeaders) !== JSON.stringify(expectedHeaders))
    throw new Error(`${source.state.code}: unexpected county columns`);
  if (!source.datasetUpdated || !source.stateInstallationsDisplay) throw new Error(`${source.state.code}: missing state provenance or total`);
  for (const row of source.countyRows) {
    const url = new URL(row.countyUrl);
    if (row.cells.length !== 5 || !row.countyName || url.origin !== "https://panelcensus.com"
      || !url.pathname.startsWith(`/solar/${source.state.slug}/`)) throw new Error(`${source.state.code}: invalid county row`);
    if (countyIds.has(row.countyUrl)) throw new Error(`Duplicate county: ${row.countyUrl}`);
    countyIds.add(row.countyUrl);
    const record = {
      stateCode: source.state.code, stateName: source.state.name, countyName: row.countyName,
      countySlug: url.pathname.split("/").at(-1),
      recordedInstallations: numeric(row.cells[1], "count"), installationsDisplay: row.cells[1],
      homesWithSolarPercent: numeric(row.cells[2], "percent"), homesWithSolarDisplay: row.cells[2],
      capacityKw: capacity(row.cells[3]), capacityDisplay: row.cells[3],
      medianPricePerWatt: numeric(row.cells[4], "price"), medianPriceDisplay: row.cells[4],
      limitedData: row.limitedData, datasetUpdated: source.datasetUpdated, scrapedAt: source.scrapedAt,
      sourceStateUrl: source.sourceUrl, sourceCountyUrl: row.countyUrl,
    };
    if (record.recordedInstallations === null) throw new Error(`${row.countyUrl}: missing installation count`);
    counties.push(record);
  }
  const stateRows = counties.filter((county) => county.stateCode === source.state.code);
  const stateRecordedInstallations = numeric(source.stateInstallationsDisplay, "count");
  const countyRecordedInstallationsSum = stateRows.reduce((sum, county) => sum + county.recordedInstallations, 0);
  summaries.push({
    stateCode: source.state.code, stateName: source.state.name, stateSlug: source.state.slug,
    sourceUrl: source.sourceUrl, httpStatus: source.httpStatus,
    countyTablePresent: source.countyTablePresent, countyRowCount: stateRows.length,
    limitedDataCountyCount: stateRows.filter((county) => county.limitedData).length,
    stateRecordedInstallations, stateCapacityKw: capacity(source.stateCapacityDisplay || ""),
    stateCapacityDisplay: source.stateCapacityDisplay,
    countyRecordedInstallationsSum, countySumMinusStateTotal: countyRecordedInstallationsSum - stateRecordedInstallations,
    underReported: source.underReported, datasetUpdated: source.datasetUpdated, scrapedAt: source.scrapedAt,
    sourceSnapshot: `sources/${source.state.slug}.json`, renderedHtmlSha256: source.renderedHtmlSha256,
  });
}
if (summaries.length !== 50 || new Set(summaries.map((state) => state.stateCode)).size !== 50)
  throw new Error("All 50 states must be accounted for before publishing the dataset");
const dataset = {
  schemaVersion: 1, provider: "PanelCensus", source: "https://panelcensus.com/solar", scrapedAt: new Date().toISOString(),
  scope: "Every county row published on the solar pages for all 50 US states; District of Columbia excluded",
  notes: [
    "These are county aggregate counts, not individual installation records or locations.",
    "The source assigns counties using installation ZIP codes and a Census ZCTA crosswalk; boundary assignments are approximate.",
    "Counties absent from a state page are not assumed to have zero installations. Missing values remain null.",
    "Limited-data rows are retained even if hidden by the page filter. Source flags are preserved.",
    "State headline totals and county sums are preserved independently; reported inconsistencies are not corrected or redistributed.",
    "Capacity values in kW are conversions of the rounded displayed values, not more precise measurements.",
  ],
  summary: { stateCount: summaries.length, countyRowCount: counties.length,
    statesWithCountyTables: summaries.filter((state) => state.countyTablePresent).length,
    statesWithoutCountyTables: summaries.filter((state) => !state.countyTablePresent).map((state) => state.stateCode),
    limitedDataCountyCount: counties.filter((county) => county.limitedData).length,
    countyRecordedInstallationsSum: counties.reduce((sum, county) => sum + county.recordedInstallations, 0),
    stateRecordedInstallationsSum: summaries.reduce((sum, state) => sum + state.stateRecordedInstallations, 0) },
  states: summaries, counties,
};
function csv(rows, fields) {
  const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  return [fields.join(","), ...rows.map((row) => fields.map((field) => quote(row[field])).join(","))].join("\n") + "\n";
}
await atomic(resolve(directory, "us-county-solar.json"), JSON.stringify(dataset, null, 2) + "\n");
await atomic(resolve(directory, "us-county-solar.csv"), csv(counties, Object.keys(counties[0] || {})));
await atomic(resolve(directory, "state-coverage.csv"), csv(summaries, Object.keys(summaries[0])));
console.log(JSON.stringify(dataset.summary, null, 2));
