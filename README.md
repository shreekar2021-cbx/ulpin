# ULPIN Land & Agriculture Intelligence

Expansion of the existing FastAPI / vanilla JavaScript / Three.js project. The original 12 Hyderabad parcel IDs, ULPINs, building geometry and vertical records remain intact.

## Run

From this directory in PowerShell:

```powershell
.\.venv\Scripts\python.exe app.py
```

Open http://127.0.0.1:8000. When that port is occupied, use:

```powershell
.\.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8001
```

The expanded instance was verified on http://127.0.0.1:8001. No frontend build or internet connection is needed to run the demo: Three.js r128, OrbitControls, Lucide and compiled Tailwind CSS are bundled in `static/vendor`.

For a fresh Python environment, install `requirements.txt` before running the server.

## Demo Workflow

1. Open Land and choose a regional area or land-use filter. Check parcels, select all filtered results, or load a package. Adding a package unions its parcels with the current selection.
2. Keep Multi-select enabled to inspect records without discarding the combination. Clicking a field or floor in the scene toggles membership; yellow boundaries indicate selected parcels.
3. Save a named collection. Modify its membership and use Update to edit the saved collection. Predefined packages are protected; save a copy to change them.
4. Inspect Overview, Agriculture, Soil, Weather and Risks. Fit selection frames the combination in 3D. Scene color can show flood, drought or heat scores.
5. Compare two to eight packages/custom selections. In Decision workbench, choose a question and scope, then Assess. Package ranking only includes whole packages contained in the scope; choose All indexed land to rank all packages.
6. Reassess after changing weather source or selection. Export the complete selected intelligence as JSON. Dashboard search, Registry CSV/JSON, floor inspection, conflict checks, officer actions and specimen printing remain available in their original tabs.

## Data and Methods

- 84 synthetic parcels, 48 agricultural plots, seven areas across six states, eight predefined packages. All seven requested land-use categories are represented.
- `data.py`: preserved legacy seeds, deterministic regional generators, area relationships, soil/agriculture profiles, packages and original registry/conflict helpers.
- `weather.py`: provider abstraction, five-day demo forecast, Open-Meteo adapter, explicit fallback and 15-minute live response cache. Live mode uses each parcel centroid, bounded concurrent requests and a four-second upstream timeout. Failed/incomplete responses fall back to demo data and are labeled. Reassess uses cached live data until its 15-minute TTL expires.
- `intelligence.py`: explainable hazard points, suitability components/weights, area-weighted aggregation and comparisons. Each unique parcel is counted once, even when packages overlap. Agricultural suitability and water summaries exclude non-agricultural land; their values are null when no agricultural land is selected.
- Hazards use explicit threshold contributions; overall parcel risk is the maximum applicable hazard score. Package risk includes both area-weighted mean and worst-parcel score. Landslide/wildfire applicability depends on the modeled terrain/vegetation. Scores are not probabilities.
- Weather divergence flags parcels >=4 C or >=15 mm/day from their package's area-weighted mean. Forecast precipitation is a daily total; current precipitation is the provider's current-period value. Area-weighted rain probability is descriptive, not the probability of rain anywhere in a package.

## Agent Tools

Discover tools at `/api/intelligence/tools`; full typed contracts are available at `/docs` and `/openapi.json`.

| Tool | Endpoint |
| --- | --- |
| Parcel details | `GET /api/parcels/{parcel_id}` |
| Areas and packages | `GET /api/areas`, `GET /api/packages` |
| Package details + aggregation | `GET /api/packages/{package_id}` |
| Soil, agriculture, weather, risk, suitability | `GET /api/intelligence/parcels/{parcel_id}/{component}` |
| Combined statistics | `POST /api/intelligence/aggregate` |
| Comparison | `POST /api/intelligence/compare` |
| Scoped recommendation | `POST /api/intelligence/analyze` |
| Save/update collection | `POST /api/packages`, `PUT /api/packages/{package_id}` |

Aggregate payload example:

```json
{"parcel_ids": ["P-PB-201", "P-KL-401"], "provider": "demo"}
```

Analysis adds `question`, one of `best_agriculture`, `highest_flood`, `favorable_soil_weather`. Comparison accepts `targets`, each containing either `package_id` or `parcel_ids` (plus an optional `name`). Provider is `demo` or `live`.

The decision workbench is a deterministic tool consumer, not a pretend chatbot. A future agent can observe the selection, retrieve components, inspect contributions, recommend candidates, present results and verify by requesting fresh assessments. No LLM service is required or simulated.

## Verification

```powershell
.\.venv\Scripts\python.exe -m unittest -v test_intelligence
.\.venv\Scripts\python.exe -m unittest -v test_spatial
.\.venv\Scripts\python.exe test_api.py
npm.cmd ci
npm.cmd run test:browser
node test_spatial.cjs
```

HTTP/browser checks default to port 8001; set `$env:ULPIN_URL='http://127.0.0.1:8002'` to test another server. Browser checks use installed Chrome, test desktop/mobile, check WebGL pixels, and save screenshots to `artifacts`. Tests exercise officer status changes and create a temporary demo collection in the running session. Restart the server to reset all session data.

The spatial view renders one area at a time, initially Hyderabad. Area filters, district searches and parcel inspection replace the scene without navigation. Each area has deterministic local polygon boundaries, building footprints, roads and cultivation patterns from `spatial.py`. These are synthetic layouts, not surveyed geometry. Multi-area packages retain their analytical selection; the scene shows the active area and Fit frames only its selected parcels. `test_spatial.cjs` checks Hyderabad/Jodhpur replacement, resource disposal, repeated-switch memory counts, stale searches, other areas and mobile framing.

To regenerate utility CSS after adding utility classes, run `npm.cmd run build:css`. Node is only needed for development/testing.

## Hackathon Disclosures

All ownership, identifiers, land boundaries, crops, soil, terrain and risk data are synthetic. Soil values are not field measurements. Live weather, when available, is real provider output associated with synthetic parcel locations; its provenance is shown per parcel. Open-Meteo documentation and attribution: https://open-meteo.com/en/docs (CC BY 4.0 data attribution).

Suitability is general screening, with a simplified moisture target for rice; it is not a calibrated crop/yield model. No predictions of actual disasters, legal land suitability or investment outcomes are made. Schematic 3D clusters are not geographic distances or surveyed GIS geometry. Collections do not prove parcel contiguity. Existing overlap volumes are simulated.

Custom packages, officer actions and audit entries are in-memory and reset when the server restarts; there is no database, authentication or multi-user isolation. The existing property-card QR pattern is decorative, not a standards-compliant QR code. Property extracts are specimens, not legal records.

Bundled frontend libraries retain their upstream licenses in `static/vendor`.
