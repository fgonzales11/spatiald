# PanelCensus TECO site collection

`teco-sites.csv` contains every one of the 1,112 unique records in the public
search at https://panelcensus.com/sites?operator=Tampa%20Electric%20Co.
All 23 search pages and all 1,112 detail pages were read. The last search page
contains 12 records and has no next-page link. The operator profile separately
reports 1,131 records; that discrepancy is retained, not resolved by inventing
additional search results.

All records have published coordinates. Only 273 report system size; 839 have
blank size cells. These blanks mean unknown, not zero. Published sizes are
converted to kW and retained as reported, including unusual values. AC/DC
basis is retained only where the detail page states it.

Coordinates come from each detail page's OpenStreetMap location link to retain
full published precision. The original displayed size/location, source URL,
retrieval time, TECO role and data status are included in the CSV. The search
includes utility-owned plants as well as installations interconnected through
TECO. Separate public records are retained even if they share coordinates.

`listing-pages/`, `listing-index.json`, `operator-profile.json` and `sites/`
preserve the source captures. HTTP captures retain their actual response
status. Native in-app browser captures record `httpStatus: null`,
`pageVerified: true` and `readMethod: "in-app browser"`, because that interface
does not expose HTTP status. The site's normal browser verification completed
in that browser; no authentication or security bypass was used.

`scripts/scrape-teco-sites.mjs --resume` reuses the complete index and saved
detail captures. `teco-sites.json` is the structured export and
`csv-coverage.json` records completed coverage and the CSV hash. Every field
in every CSV row was checked against its source capture.
