# TECO modeled generator locations

`teco-asymmetric-sgen.csv` contains all 883 `asymmetric_sgen` devices in the 63
PKLs under `/Users/admin/git/itron_pf_platform/pkls/core_product_client/teco`.
The requested case-insensitive `PV` name filter found no matches. All devices
are included following the user's clarification; technology is unclassified
because names are numeric IDs and the model `type` fields are empty.

## Device and coordinate identity

One CSV row represents one generator element in one source model. The unique
key is `(source_model, generator_id)`. Generator names alone are not unique.
The 1,758 circuit/phase rows are combined into 883 device rows. Phase
connections and circuit IDs are retained. Every device has a single connected
bus, and latitude/longitude come from that bus's `bus_geodata` geographic
columns. The projected `x`/`y` fields are not exported as geographic coordinates.

All 883 bus joins were checked against both geographic-column aliases and the
bus GeoJSON. For 880 devices the recorded coordinate provenance is
`InstDTrans.X_MUL/Y_MUL (EPSG:3857 to EPSG:4326)`; the remaining three use
`Node.Longitude/Latitude`. Thus these are the modeled connected-bus positions,
which can differ from a rooftop or permit address location.

## Power values

- `modeled_p_kw`: sum of the device's circuit `p_mw`, converted to kW.
- `modeled_q_kvar`: sum of circuit `q_mvar`, converted to kvar.
- `effective_p_kw`: sum of `p_mw * scaling * 1000` for in-service circuits.
- `rated_sn_kva`: sum of circuit `sn_mva`, converted to kVA, only if all circuit
  values are present. It is blank for every device in these models.

Modeled active power is an operating-point value, **not installed PV system
capacity**. It should not be treated as directly comparable to PanelCensus AC
or DC nameplate system size. Blank values are unknown, not zero. No device is
removed based on in-service status.

## Reproduction and checks

`scripts/extract-teco-sgen.py --selection all --output
data/solar/teco-models/teco-asymmetric-sgen.json` stages the source records.
The script requires pandas and the model's pandapower pickle class; the source
project's existing `.venv/bin/python` provides those dependencies. No model
files are modified and no power flow is run.

## Public-site comparison

The CSV includes the nearest PanelCensus record, its published size and source
URL, the great-circle distance, and every public record within 50 metres.
The comparison reads all 1,112 sites from the complete 23-page TECO public
search. Seventy-eight model devices have one public record within 50 metres;
11 have multiple candidates; 794 have none within that distance. These are
spatial candidates, not confirmed device identities or capacity matches.
The model files cover only the supplied feeders, while the public operator
search covers a wider area. The 50-metre radius is an explicit review threshold,
not a measurement-accuracy guarantee. Ties for the nearest record retain the
first record in the source search order; all candidates are separately listed.

`scripts/crossvalidate-teco-sgen.py` produces the comparison JSON intermediate
after every public detail page has been captured. No modeled power is used to
fill a missing public system size.

`teco-asymmetric-sgen.json` preserves source-model hashes and extraction
coverage. `verification.json` records the CSV hash and coverage. Every exported
CSV row was independently rejoined to its original PKL bus and checked against
the original circuit count and summed active power.
