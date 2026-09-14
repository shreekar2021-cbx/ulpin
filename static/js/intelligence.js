"use strict";

const land = { selected: new Set(), packages: [], areas: [], summary: null, view: "overview", revision: 0, ready: false, editingId: null, risks: {} };
const landMetric = (label, value) => `<div class="land-metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value ?? "Not applicable")}</strong></div>`;
const landNumber = (n, suffix = "") => n == null ? "Not applicable" : `${Number(n).toLocaleString(undefined, {maximumFractionDigits: 2})}${suffix}`;
const landTone = n => n >= 65 ? "var(--danger)" : n >= 35 ? "var(--warning)" : "var(--accent-2)";

function landFiltered() {
  const query = $("landQuery").value.trim().toLowerCase();
  return state.parcels.filter(p => (!$("landArea").value || p.area_id === $("landArea").value) &&
    (!$("landUse").value || p.land_use === $("landUse").value) &&
    (!query || [p.id, p.survey_no, p.parcel_ulpin, p.district, p.agriculture?.crop].join(" ").toLowerCase().includes(query)));
}

function renderLandBrowser() {
  const items = landFiltered();
  $("landBrowser").innerHTML = items.map(p => `<div class="land-row ${land.selected.has(p.id) ? "included" : ""}">
    <input type="checkbox" data-land-id="${p.id}" aria-label="Include ${p.id}" ${land.selected.has(p.id) ? "checked" : ""} />
    <button class="land-inspect" data-inspect-land="${p.id}" title="Inspect ${p.id}"><strong>${p.id}</strong><span>${escapeHtml(p.district)} / ${escapeHtml(p.agriculture?.crop || p.land_use)}</span></button>
    <span>${landNumber(p.area_ha, " ha")}</span><span class="land-use-dot" style="background:${toCssHex(colorForParcel(p))}" title="${escapeHtml(p.land_use)}"></span></div>`).join("") || '<p class="land-empty">No matching land.</p>';
  $("landCount").textContent = `${land.selected.size} selected / ${items.length} shown`;
  $("landBrowser").querySelectorAll("[data-land-id]").forEach(el => el.addEventListener("change", () => {
    if (!$("landMulti").checked) land.selected.clear();
    if (el.checked) land.selected.add(el.dataset.landId); else land.selected.delete(el.dataset.landId);
    if (el.checked) {
      const parcel = state.parcels.find(p => p.id === el.dataset.landId);
      setSceneLocation(parcel.area_id, {parcelId: parcel.id, resetLand: false});
    }
    $("landPackage").value = "";
    landSelectionChanged();
  }));
  $("landBrowser").querySelectorAll("[data-inspect-land]").forEach(el => el.addEventListener("click", () => selectParcelById(el.dataset.inspectLand, true)));
}

function landActiveParcel(id) {
  if (!land.ready) return;
  if (!$("landMulti").checked) {
    if (land.selected.size === 1 && land.selected.has(id)) return;
    land.selected = new Set([id]);
    $("landPackage").value = "";
    landSelectionChanged();
  }
}

function landSelectionChanged() {
  renderLandBrowser();
  renderSceneSummary();
  $("updatePackage").disabled = !land.editingId;
  $("analysisResult").replaceChildren();
  refreshLand();
  if (state.sceneReady) requestSceneFrame();
}

async function refreshLand() {
  const revision = ++land.revision;
  land.summary = null;
  $("landError").textContent = "";
  $("exportLand").disabled = true;
  $("landAssessment").textContent = land.selected.size ? "Assessing selection..." : "No selection";
  renderLandInsights();
  if (!land.selected.size) return;
  try {
    const summary = await api("/api/intelligence/aggregate", {method: "POST", body: JSON.stringify({parcel_ids: [...land.selected], provider: $("weatherProvider").value})});
    if (revision !== land.revision) return;
    land.summary = summary;
    summary.items.forEach(r => { state.weatherByParcel[r.parcel_id] = r.weather; land.risks[r.parcel_id] = r.risks; });
    if (state.sceneReady) requestSceneFrame();
    rankSceneParcels();
    $("landAssessment").textContent = `Assessed ${new Date(summary.assessed_at).toLocaleTimeString()} / ${summary.weather.sources.join(", ")}`;
    $("exportLand").disabled = false;
    renderLandInsights();
    renderSiteSelection();
    updateParcelWeatherPanel(state.parcelById.get(hoveredFloor?.userData.parcelId || hoveredParcel?.userData.parcelId) || state.selectedParcel);
  } catch (err) {
    if (revision !== land.revision) return;
    $("landAssessment").textContent = "Assessment failed";
    $("landError").textContent = err.message;
  }
}

function landTable(headers, rows) {
  return `<div class="land-table-wrap"><table class="land-table"><thead><tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(c => `<td>${escapeHtml(c ?? "Not applicable")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function landForecast(forecast) {
  return `<div class="land-forecast">${forecast.map(d => `<div><strong>${escapeHtml(d.date.slice(5))}</strong><div class="rain-column"><span style="height:${Math.max(2, d.rainfall_mm / Math.max(1, ...forecast.map(f => f.rainfall_mm)) * 65)}px"></span></div><b>${landNumber(d.rainfall_mm, " mm")}</b><span>${landNumber(d.temperature_max, " C max")}</span><span>${landNumber(d.rain_probability, "% rain")}</span></div>`).join("")}</div>`;
}

function renderLandInsights() {
  const container = $("landInsights"), s = land.summary;
  if (land.view === "compare") { renderLandComparison(); return; }
  if (!s) { container.innerHTML = `<p class="land-empty">${land.selected.size ? "Loading selected intelligence..." : "No land selected"}</p>`; return; }
  const ag = s.items.filter(r => r.agriculture);
  let html = "";
  if (land.view === "overview") {
    html = `<div class="land-metrics">${landMetric("Total land", landNumber(s.total_area_ha, " ha"))}${landMetric("Parcels / areas", `${s.parcel_count} / ${s.area_count}`)}${landMetric("Agricultural area", landNumber(s.agricultural_area_ha, " ha"))}${landMetric("Agriculture suitability", landNumber(s.suitability_score, " /100"))}${landMetric("Mean risk / worst parcel", `${s.risks.overall_score} / ${s.risks.worst_parcel_score}`)}${landMetric("Water availability", landNumber(s.water_availability, " /100"))}</div>
    <h3>Land-use composition</h3><div class="land-composition">${Object.entries(s.land_use_ha).map(([use, area]) => `<span title="${escapeHtml(use)}: ${landNumber(area, " ha")}" style="width:${area/s.total_area_ha*100}%;background:${toCssHex(TYPE_COLORS[use])}"></span>`).join("")}</div>
    <div class="land-key">${Object.entries(s.land_use_ha).map(([use, area]) => `<span><i style="background:${toCssHex(TYPE_COLORS[use])}"></i>${escapeHtml(use)} ${landNumber(area, " ha")}</span>`).join("")}</div>
    <div class="land-metrics">${landMetric("Soil types", s.soil.types.join(", "))}${landMetric("Soil quality", landNumber(s.soil.quality, " /100"))}${landMetric("Temperature", landNumber(s.weather.temperature, " C"))}${landMetric("Expected rainfall today", landNumber(s.weather.expected_rainfall_mm, " mm"))}</div><p class="section-kicker">Area-weighted means. Parcels may be non-contiguous; local risk maxima are retained.</p>`;
  } else if (land.view === "agriculture") {
    html = ag.length ? ag.map(r => `<article class="land-detail"><div class="section-title"><h3>${r.parcel_id} / ${escapeHtml(r.agriculture.crop)}</h3><span class="pill">${r.suitability.label} ${r.suitability.score}/100</span></div><div class="land-metrics">${landMetric("Cultivation", r.agriculture.cultivation_status)}${landMetric("Irrigation", r.agriculture.irrigation)}${landMetric("Water availability", r.agriculture.water_availability + "/100")}${landMetric("Soil", `${r.soil.type} / ${r.soil.condition}`)}${landMetric("Moisture / pH", `${r.soil.moisture_pct}% / ${r.soil.ph}`)}${landMetric("Weather", `${r.weather.temperature} C / ${r.weather.humidity}% RH`)}</div><p class="land-stress">Crop stress: ${escapeHtml(r.suitability.stress.join(", ") || "No elevated screening signals")}</p><details><summary>Suitability factors</summary>${landTable(["Factor", "Score", "Weight"], Object.entries(r.suitability.components).map(([k,v]) => [k.replaceAll("_", " "), v, `${r.suitability.weights[k]*100}%`]))}</details></article>`).join("") : '<p class="land-empty">No agricultural land in this selection.</p>';
  } else if (land.view === "soil") {
    html = `<div class="land-metrics">${landMetric("Mean pH", s.soil.ph)}${landMetric("Mean moisture", s.soil.moisture_pct + "%")}${landMetric("Mean quality", s.soil.quality + "/100")}</div>` + landTable(["Parcel", "Soil / condition", "pH", "Moisture %", "Fertility /100", "Drainage", "Elevation m", "Slope deg"], s.items.map(r => [r.parcel_id, `${r.soil.type} / ${r.soil.condition}`, r.soil.ph, r.soil.moisture_pct, r.soil.fertility, r.soil.drainage, r.elevation_m, r.slope_deg]));
  } else if (land.view === "weather") {
    html = `<div class="land-metrics">${landMetric("Temperature", landNumber(s.weather.temperature, " C"))}${landMetric("Humidity", landNumber(s.weather.humidity, "%"))}${landMetric("Wind", landNumber(s.weather.wind_speed, " km/h"))}${landMetric("Daily expected rain", landNumber(s.weather.expected_rainfall_mm, " mm"))}</div><h3>Five-day forecast / area-weighted</h3>${landForecast(s.weather.forecast)}<p class="land-stress">Different conditions (>=4 C or >=15 mm from mean): ${escapeHtml(s.weather.different_conditions.join(", ") || "None")}</p>` + landTable(["Parcel", "Conditions", "C", "RH %", "Wind km/h", "Rain mm today", "Rain chance %", "Source / observed"], s.items.map(r => [r.parcel_id, r.weather.conditions, r.weather.temperature, r.weather.humidity, r.weather.wind_speed, r.weather.expected_rainfall_mm, r.weather.rain_probability, `${r.weather.source} / ${r.weather.observed_at}`])) + s.items.filter(r => r.weather.fallback_reason).map(r => `<p class="section-kicker">${r.parcel_id}: ${escapeHtml(r.weather.fallback_reason)}</p>`).join("");
  } else if (land.view === "risks") {
    html = `<div class="land-metrics">${landMetric("Area-weighted risk", s.risks.overall_score + "/100")}${landMetric("Worst parcel risk", s.risks.worst_parcel_score + "/100")}</div><div class="land-hazards">${Object.entries(s.risks.hazards).map(([k,h]) => `<div><strong>${escapeHtml(k.replaceAll("_", " "))}</strong><span>${h.mean_score == null ? "Not applicable" : `Mean ${h.mean_score} / max ${h.max_score}`}</span><div class="hbar"><span style="width:${h.max_score || 0}%;--bar:${landTone(h.max_score)}"></span></div><small>${h.high_risk_parcels.length} high-risk parcels</small></div>`).join("")}</div><h3>Contributing factors by parcel</h3>` + s.items.map(r => `<details class="land-risk-details"><summary>${r.parcel_id} / ${r.risks.level} / ${r.risks.overall_score}</summary>${Object.entries(r.risks.hazards).map(([k,h]) => `<p><strong>${escapeHtml(k.replaceAll("_", " "))}: ${h.score ?? "N/A"}</strong> ${escapeHtml(h.reasons.join("; "))}</p>`).join("")}</details>`).join("");
  }
  if (land.view === "weather") html += s.items.map(r => `<details class="land-risk-details"><summary>${r.parcel_id} / five-day forecast</summary>${landForecast(r.weather.forecast)}</details>`).join("");
  if (land.view === "agriculture" && ag.length) html += `<h3>Selected agricultural forecast</h3>${landForecast(s.weather.forecast)}<p class="section-kicker">Package forecast includes all selected land; parcel-specific forecasts are available in Weather.</p>`;
  container.innerHTML = html + `<p class="land-disclosure">${escapeHtml(s.disclosure)}</p>`;
}

function renderLandComparison() {
  $("landInsights").innerHTML = `<div class="land-compare-options">${land.packages.map(p => `<label><input type="checkbox" data-compare-package="${p.id}" />${escapeHtml(p.name)}</label>`).join("")}<label><input type="checkbox" id="compareCurrent" />Current selection</label></div><button id="compareLand" class="btn primary">Compare alternatives</button><div id="comparisonResult"></div>`;
  $("compareLand").onclick = async () => {
    const targets = [...document.querySelectorAll("[data-compare-package]:checked")].map(el => ({package_id: el.dataset.comparePackage}));
    if ($("compareCurrent").checked) targets.push({name: "Current selection", parcel_ids: [...land.selected]});
    if (targets.length < 2 || targets.length > 8) { toast("Select 2 to 8 alternatives", "danger"); return; }
    $("compareLand").disabled = true;
    try {
      const result = await api("/api/intelligence/compare", {method: "POST", body: JSON.stringify({targets, provider: $("weatherProvider").value})});
      if (!$("comparisonResult")) return;
      $("comparisonResult").innerHTML = landTable(["Alternative", "Parcels", "Area ha", "Agri ha", "Suitability", "Water", "Mean risk", "Worst risk"], result.items.map(r => [r.name, r.statistics.parcel_count, landNumber(r.statistics.total_area_ha), landNumber(r.statistics.agricultural_area_ha), r.statistics.suitability_score, r.statistics.water_availability, r.statistics.risks.overall_score, r.statistics.risks.worst_parcel_score]));
    } catch (err) { toast(err.message, "danger"); } finally { if ($("compareLand")) $("compareLand").disabled = false; }
  };
}

function populateLandPackages() {
  const current = $("landPackage").value;
  $("landPackage").innerHTML = '<option value="">Custom selection</option>' + land.packages.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
  $("landPackage").value = current;
}

function fitLandSelection() {
  if (!state.sceneReady || !land.selected.size) return;
  let visible = state.sceneParcels.filter(p => land.selected.has(p.id));
  if (!visible.length) {
    const first = state.parcels.find(p => land.selected.has(p.id));
    if (!first) return;
    setSceneLocation(first.area_id, {parcelId: first.id, resetLand: false});
    visible = state.sceneParcels.filter(p => land.selected.has(p.id));
  }
  set3DView(false); clearIsolation(); setOrbit(false);
  const bounds = new THREE.Box3();
  visible.forEach(p => {
    bounds.expandByPoint(new THREE.Vector3(p.position.x-p.size.w/2, 0, p.position.z-p.size.d/2));
    bounds.expandByPoint(new THREE.Vector3(p.position.x+p.size.w/2, buildingHeight(p), p.position.z+p.size.d/2));
  });
  const center = bounds.getCenter(new THREE.Vector3());
  const radius = bounds.getBoundingSphere(new THREE.Sphere()).radius;
  const fov = Math.atan(Math.tan(THREE.MathUtils.degToRad(24))*Math.min(1,perspectiveCamera.aspect));
  tweenCamera(perspectiveCamera, center.clone().addScaledVector(new THREE.Vector3(.8,1,1).normalize(), radius*1.15/Math.sin(fov)), center);
}

async function initLandIntelligence() {
  const [areas, packages] = await Promise.all([api("/api/areas"), api("/api/packages")]);
  land.areas = areas.items; land.packages = packages.items;
  $("landInventory").textContent = `${state.parcels.length} parcels / ${land.areas.length} areas / ${new Set(state.parcels.map(p=>p.state)).size} states`;
  $("landArea").innerHTML += land.areas.map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join("");
  $("landUse").innerHTML += [...new Set(state.parcels.map(p=>p.land_use))].map(u=>`<option>${escapeHtml(u)}</option>`).join("");
  populateLandPackages();
  land.ready = true;
  land.selected = new Set([state.parcels[0].id]);
  ["landArea", "landUse", "landQuery"].forEach(id => $(id).addEventListener("input", () => {
    state.searchRevision++;
    if (id === "landQuery") {
      const query = $("landQuery").value.trim().toLowerCase();
      const matches = query.length >= 2 ? land.areas.filter(a => a.district.toLowerCase().includes(query)) : [];
      if (matches.length === 1 && $("landArea").value) $("landArea").value = matches[0].id;
    }
    const items = landFiltered();
    if (id === "landArea" && $("landArea").value) setSceneLocation($("landArea").value);
    else showSearchLocation(items);
    renderLandBrowser();
  }));
  $("landMulti").onchange = () => { if (!$("landMulti").checked && land.selected.size > 1) land.selected = new Set([land.selected.values().next().value]); landSelectionChanged(); };
  $("selectVisible").onclick = () => { $("landMulti").checked = true; landFiltered().forEach(p=>land.selected.add(p.id)); $("landPackage").value=""; landSelectionChanged(); };
  $("clearLand").onclick = () => { land.selected.clear(); $("landPackage").value=""; landSelectionChanged(); };
  const load = add => {
    const p = land.packages.find(p=>p.id === $("landPackage").value);
    if (!p) return;
    land.selected = new Set([...(add ? land.selected : []), ...p.parcel_ids]);
    $("landMulti").checked = land.selected.size > 1;
    $("packageName").value = p.name;
    land.editingId = p.predefined || add ? null : p.id;
    const first = state.parcels.find(parcel => parcel.id === p.parcel_ids[0]);
    if (first) setSceneLocation(first.area_id, {parcelId: first.id, resetLand: false});
    if (add) $("landPackage").value="";
    landSelectionChanged(); fitLandSelection();
  };
  $("loadPackage").onclick=()=>load(false); $("addPackage").onclick=()=>load(true);
  $("landPackage").onchange = () => { $("updatePackage").disabled = true; };
  const save = async update => {
    if (!land.selected.size || !$("packageName").value.trim()) { toast("Select land and enter a package name", "danger"); return; }
    try {
      const p = await api("/api/packages" + (update ? `/${land.editingId}` : ""), {method: update ? "PUT" : "POST", body: JSON.stringify({name: $("packageName").value, parcel_ids:[...land.selected]})});
      land.editingId = p.id;
      land.packages = (await api("/api/packages")).items; populateLandPackages(); $("landPackage").value=p.id;
      $("updatePackage").disabled=false; toast("Package saved for this server session", "success");
      if (land.view === "compare") renderLandComparison();
    } catch(err) { toast(err.message,"danger"); }
  };
  $("savePackage").onclick=()=>save(false); $("updatePackage").onclick=()=>save(true);
  $("fitLand").onclick=fitLandSelection;
  $("refreshLand").onclick=refreshLand;
  $("weatherProvider").onchange=refreshLand;
  $("landLayer").onchange=()=>{if(state.sceneReady) requestSceneFrame();};
  $("exportLand").onclick=()=>{ if(land.summary) downloadFile("land-intelligence.json", JSON.stringify(land.summary,null,2),"application/json"); };
  document.querySelectorAll("[data-intel]").forEach(btn=>btn.onclick=()=>{land.view=btn.dataset.intel; document.querySelectorAll("[data-intel]").forEach(b=>{b.classList.toggle("active",b===btn); b.setAttribute("aria-selected",String(b===btn));}); renderLandInsights(); if (typeof updateWorkflowNav === "function") updateWorkflowNav("land");});
  $("analyzeLand").onclick=async()=>{
    const ids = $("analysisScope").value === "all" ? state.parcels.map(p=>p.id) : [...land.selected];
    if (!ids.length) { toast("Select land to assess", "danger"); return; }
    const revision=land.revision;
    $("analyzeLand").disabled=true; $("analysisResult").textContent="Assessing...";
    try {
      const result=await api("/api/intelligence/analyze",{method:"POST",body:JSON.stringify({parcel_ids:ids,provider:$("weatherProvider").value,question:$("analysisQuestion").value})});
      if(revision!==land.revision) return;
      $("analysisResult").innerHTML=result.items.length ? landTable(["Candidate", "Score /100", "Reason"],result.items.map(r=>[r.name||r.id,r.score,r.reason])) : '<p class="land-empty">No candidates meet this query. Package ranking requires complete packages within the chosen scope.</p>';
      $("analysisResult").innerHTML += '<p class="land-disclosure">Rule-based screening, not an AI prediction. Reassess after conditions change.</p>';
    } catch(err) { if (revision === land.revision) $("analysisResult").textContent=err.message; } finally { $("analyzeLand").disabled=false; }
  };
  landSelectionChanged();
}
