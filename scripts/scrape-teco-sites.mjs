import assert from "node:assert/strict";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

const directory = fileURLToPath(new URL("../data/solar/panelcensus/teco/", import.meta.url));
const seed = "https://panelcensus.com/sites?operator=Tampa%20Electric%20Co";
const profile = "https://panelcensus.com/operators/tampa-electric-co-453";
const resume = process.argv.includes("--resume");
if (process.argv.slice(2).some((arg) => arg !== "--resume")) throw new Error("Usage: node scripts/scrape-teco-sites.mjs [--resume]");
await mkdir(resolve(directory, "listing-pages"), { recursive: true });
await mkdir(resolve(directory, "sites"), { recursive: true });
async function save(path, value) {
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2) + "\n");
  await rename(`${path}.tmp`, path);
}
function officialSearch(url) {
  const u = new URL(url);
  assert.equal(u.origin, "https://panelcensus.com");
  assert.equal(u.pathname, "/sites");
  assert.equal(u.searchParams.get("operator"), "Tampa Electric Co");
  return u;
}
function sizeKw(display) {
  if (!display || /^[—–-]$/.test(display.trim())) return null;
  const match = /^([\d,.]+)\s*(kW|MW|GW|W)$/.exec(display.trim());
  assert.ok(match, `Unexpected system size: ${display}`);
  const value = Number(match[1].replaceAll(",", "")) * { kW: 1, MW: 1000, GW: 1e6, W: 0.001 }[match[2]];
  assert.ok(Number.isFinite(value) && value >= 0);
  return Number(value.toFixed(8));
}
const browser = await chromium.launch();
const context = await browser.newContext();
const listings = [], sites = [], ids = new Set(), visitedPages = new Set();
let profileReportedRecords = null;
try {
  let savedIndex = null;
  if (resume) {
    try {
      savedIndex = JSON.parse(await readFile(resolve(directory, "listing-index.json"), "utf8"));
      assert.equal(savedIndex.seedUrl, seed);
      assert.equal(savedIndex.endOfPaginationReached, true);
      assert.ok(savedIndex.results.length > 0);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  if (savedIndex) {
    listings.push(...savedIndex.results);
    profileReportedRecords = savedIndex.profileReportedRecords;
    for (let number = 1; number <= savedIndex.pageCount; number++) visitedPages.add(number);
    for (const listing of listings) {
      assert.ok(!ids.has(listing.siteId));
      ids.add(listing.siteId);
    }
    console.log(`Reusing complete listing: ${listings.length} sites across ${visitedPages.size} pages`);
  } else {
  const page = await context.newPage();
  const profileResponse = await page.goto(profile, { waitUntil: "domcontentloaded", timeout: 30000 });
  assert.equal(profileResponse.status(), 200);
  const profileText = await page.locator("main").innerText();
  profileReportedRecords = Number(/([\d,]+) recorded solar installations/.exec(profileText)?.[1].replaceAll(",", ""));
  assert.ok(Number.isSafeInteger(profileReportedRecords));
  await save(resolve(directory, "operator-profile.json"), { sourceUrl: profile, retrievedAt: new Date().toISOString(),
    reportedRecords: profileReportedRecords, operator: "Tampa Electric Co" });
  let next = seed;
  while (next) {
    const u = officialSearch(next);
    const pageNumber = Number(u.searchParams.get("page") || 1);
    assert.ok(!visitedPages.has(pageNumber), "Pagination must not loop");
    visitedPages.add(pageNumber);
    let source;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await page.goto(next, { waitUntil: "domcontentloaded", timeout: 30000 });
        assert.equal(response.status(), 200);
        source = await page.locator("main").evaluate((main) => {
          const table = [...main.querySelectorAll("table")].find((t) => [...t.querySelectorAll("th")].some((h) => h.textContent.trim().toLowerCase() === "size"));
          if (!table) throw new Error("Search table not found");
          return {
            resultLabel: /Showing\s+[^\n]+/.exec(main.innerText)?.[0] || null,
            headers: [...table.querySelectorAll("th")].map((h) => h.textContent.trim()),
            rows: [...table.querySelectorAll("tbody tr")].map((row) => ({
              cells: [...row.querySelectorAll("td")].map((cell) => cell.innerText.trim()),
              sourceUrl: row.querySelector('a[href^="/sites/"]')?.href || null,
            })),
            nextUrl: [...main.querySelectorAll("a")].find((a) => /^Next\s*→$/.test(a.textContent.trim()))?.href || null,
          };
        });
        break;
      } catch (error) { if (attempt === 2) throw error; await page.waitForTimeout(3000 * (attempt + 1)); }
    }
    source = { pageNumber, sourceUrl: next, retrievedAt: new Date().toISOString(), ...source };
    for (const row of source.rows) {
      const url = new URL(row.sourceUrl);
      assert.equal(url.origin, "https://panelcensus.com");
      assert.match(url.pathname, /^\/sites\/[^/]+$/);
      const id = decodeURIComponent(url.pathname.split("/").at(-1));
      assert.ok(!ids.has(id), `Duplicate result across pages: ${id}`);
      ids.add(id);
      listings.push({ siteId: id, sourceUrl: url.href, listingPageNumber: pageNumber, listingCells: row.cells });
    }
    await save(resolve(directory, "listing-pages", `page-${String(pageNumber).padStart(3, "0")}.json`), source);
    console.log(`Search page ${pageNumber}: ${source.rows.length} sites; ${listings.length} total`);
    if (source.nextUrl) {
      assert.equal(Number(officialSearch(source.nextUrl).searchParams.get("page")), pageNumber + 1);
      assert.equal(source.rows.length, 50, "Intermediate result pages must be complete");
    }
    next = source.nextUrl;
    await page.waitForTimeout(250);
  }
  await page.close();
  assert.ok(listings.length > 0);
  await save(resolve(directory, "listing-index.json"), { seedUrl: seed, retrievedAt: new Date().toISOString(),
    pageCount: visitedPages.size, endOfPaginationReached: true, profileReportedRecords, results: listings });
  }
  let cursor = 0, completed = 0;
  await Promise.all(Array.from({ length: 1 }, async () => {
    const detail = await context.newPage();
    while (cursor < listings.length) {
      const index = cursor++, listing = listings[index];
      const path = resolve(directory, "sites", `${listing.siteId}.json`);
      if (resume) {
        try {
          const saved = JSON.parse(await readFile(path, "utf8"));
          if (saved.siteId === listing.siteId && saved.sourceUrl === listing.sourceUrl && (saved.httpStatus === 200 || (saved.pageVerified === true && saved.readMethod === 'in-app browser'))) {
            sites[index] = saved; completed++;
            if (completed % 50 === 0) console.log(`Detail pages: ${completed}/${listings.length} (using saved captures)`);
            continue;
          }
        } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      let source;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await detail.goto(listing.sourceUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
          assert.equal(response.status(), 200, `${listing.siteId}: detail page must load`);
          source = await detail.locator("main").evaluate((main) => {
            const text = main.innerText;
            const label = [...main.querySelectorAll("div,p,span")].find((e) => e.childElementCount === 0 && e.textContent.trim().toLowerCase() === "system size");
            const card = label?.parentElement;
            const map = [...main.querySelectorAll("a")].find((a) => a.textContent.trim().toLowerCase() === "map" && a.href.includes("openstreetmap.org"));
            const parties = [...main.querySelectorAll("table")].find((table) => table.querySelector("th")?.textContent.trim().toLowerCase() === "role");
            return {
              siteName: main.querySelector("h1")?.textContent.trim() || null,
              locationDescription: main.querySelector("h1")?.nextElementSibling?.textContent.trim() || null,
              sizeDisplay: card?.children[1]?.textContent.trim() || null,
              capacityBasis: card?.children[2]?.textContent.trim() || null,
              locationDisplay: /Location:\s*([-+\d.]+),\s*([-+\d.]+)/.exec(text)?.[0] || null,
              mapUrl: map?.href || null,
              recordId: /Record\s+(\S+)\s+·/.exec(text)?.[1] || null,
              parties: parties ? [...parties.querySelectorAll("tbody tr")].map((row) => {
                const cells = [...row.querySelectorAll("td")];
                return { role: cells[0]?.textContent.trim(), name: cells[1]?.textContent.trim() };
              }) : [],
            };
          });
          assert.equal(source.recordId, listing.siteId, "Detail page must match result identity");
          assert.ok(source.siteName && source.sizeDisplay !== null, "Site identity and size field must be present");
          source = { ...listing, httpStatus: response.status(), retrievedAt: new Date().toISOString(), ...source };
          break;
        } catch (error) {
          if (attempt === 2) throw error;
          console.log(`${listing.siteId}: request unavailable; backing off before retry ${attempt + 1}/2`);
          await detail.waitForTimeout(30000);
        }
      }
      let latitude = null, longitude = null, coordinateSource = null;
      if (source.mapUrl) {
        const url = new URL(source.mapUrl);
        const lat = url.searchParams.get("mlat"), lon = url.searchParams.get("mlon");
        if (lat?.trim() && lon?.trim()) { latitude = Number(lat); longitude = Number(lon); coordinateSource = "site map link"; }
      }
      if (latitude === null && source.locationDisplay) {
        const coords = /Location:\s*([-+\d.]+),\s*([-+\d.]+)/.exec(source.locationDisplay);
        latitude = Number(coords[1]); longitude = Number(coords[2]); coordinateSource = "site location display";
      }
      if (latitude !== null) assert.ok(Number.isFinite(latitude) && Math.abs(latitude) <= 90 && Number.isFinite(longitude) && Math.abs(longitude) <= 180);
      const matchingParties = source.parties.filter((party) => party.name === "Tampa Electric Co");
      assert.ok(matchingParties.length, `${listing.siteId}: must identify Tampa Electric Co on the detail page`);
      const systemSizeKw = sizeKw(source.sizeDisplay);
      const missing = [systemSizeKw === null && "system size not reported", latitude === null && "coordinates not reported"].filter(Boolean);
      source = { ...source, systemSizeKw, latitude, longitude, coordinateSource,
        tecoRoles: matchingParties.map((party) => party.role), dataStatus: missing.join("; ") || "size and coordinates reported" };
      await save(path, source);
      sites[index] = source; completed++;
      if (completed % 50 === 0 || completed === listings.length) console.log(`Detail pages: ${completed}/${listings.length}`);
      await detail.waitForTimeout(1000);
    }
    await detail.close();
  }));
  assert.equal(sites.filter(Boolean).length, listings.length);
  const records = sites.map((site) => ({
    system_size_kw: site.systemSizeKw, latitude: site.latitude, longitude: site.longitude,
    site_id: site.siteId, site_name: site.siteName, capacity_basis: site.capacityBasis,
    location_description: site.locationDescription, teco_role: site.tecoRoles.join("; "),
    size_as_displayed: site.sizeDisplay, location_as_displayed: site.locationDisplay,
    coordinate_source: site.coordinateSource, data_status: site.dataStatus,
    source_url: site.sourceUrl, retrieved_utc: site.retrievedAt,
  }));
  const summary = { resultPages: visitedPages.size, endOfPaginationReached: true, profileReportedRecords,
    sitesFound: listings.length, detailPagesRead: sites.length,
    sitesWithSystemSize: sites.filter((site) => site.systemSizeKw !== null).length,
    sitesWithCoordinates: sites.filter((site) => site.latitude !== null).length,
    sitesWithSizeAndCoordinates: sites.filter((site) => site.systemSizeKw !== null && site.latitude !== null).length,
    sitesMissingSystemSize: sites.filter((site) => site.systemSizeKw === null).length,
    sitesMissingCoordinates: sites.filter((site) => site.latitude === null).length };
  await save(resolve(directory, "teco-sites.json"), { provider: "PanelCensus", operator: "Tampa Electric Co",
    source: seed, scrapedAt: new Date().toISOString(), summary,
    notes: ["Every result in the operator search is included, including plants and systems interconnected through the utility.",
      "Capacity is the size as published on the detail page, converted to kW if necessary; AC/DC basis is retained when provided.",
      "Coordinates use the detail page's map link for full published precision, falling back to the displayed Location text.",
      "Absent sizes and coordinates are null and must not be interpreted as zero. No coordinates or capacities are inferred.",
      "Separate source records are retained even when they refer to the same plant or share coordinates."], records });
  console.log(JSON.stringify(summary, null, 2));
} finally { await browser.close(); }
