# PanelCensus county solar installation counts

This snapshot contains every county row published on PanelCensus’s solar pages for **all 50 US states**. District of Columbia is excluded. These are county aggregates, not individual installation addresses or point locations.

- [us-county-solar.csv](us-county-solar.csv): 1,713 county records, with recorded installations, homes-with-solar percentage, displayed capacity, capacity converted to kW, median price per watt, limited-data flag, source links, and source/scrape dates.
- [us-county-solar.json](us-county-solar.json): the same records with state summaries, provenance, and interpretation notes.
- [state-coverage.csv](state-coverage.csv): all 50 states, row counts, limited-data counts, state headline totals, county sums, and their differences.
- [sources/](sources/): the original county table cell values captured from each state page, including rows hidden by the page’s limited-data filter.
- [verification.json](verification.json): results of a second browser read comparing every exported row and installation count against all 50 current state tables.

**708 limited-data counties are included.** Counties absent from a state page are not assigned zero installations. Missing percentages, capacities, or prices remain null in JSON and blank in CSV. County names are preserved, including parishes, boroughs, census areas, and independent cities. No inferred FIPS codes or geographic coordinates are added.

PanelCensus assigns counties from installation ZIP codes using a Census ZCTA crosswalk. These assignments can be approximate at county boundaries. The source’s county sums differ from its state headline totals; both are preserved independently rather than reconciled. The coverage file records the difference for each state. Capacity conversions retain the precision of the rounded displayed source values.

Source: [PanelCensus solar by state](https://panelcensus.com/solar), starting from the [California county table](https://panelcensus.com/solar/california).

From the repository root:

```sh
npm run scrape:solar-counties
npm run verify:solar-counties
```

The scraper uses a normal Chromium browser, reads two state pages at a time, and captures every county table row. Install Chromium once if needed with `npx playwright install chromium`. A failed scrape retains its completed source captures and does not publish an incomplete combined dataset. Resume interrupted collection with `npm run scrape:solar-counties -- --resume`; this reuses captured states and therefore may combine scrape dates. Run without `--resume` for a fresh snapshot of all states.

The files are reference data and have no map-layer imports.
