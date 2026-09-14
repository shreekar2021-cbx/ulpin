    "use strict";

    const state = {
      parcels: [],
      parcelById: new Map(),
      filteredParcels: [],
      activeAreaId: "HYD",
      sceneParcels: [],
      locationRevision: 0,
      searchRevision: 0,
      selectedParcel: null,
      selectedFloor: null,
      overlap: null,
      preflightOverlaps: [],
      theme: localStorage.getItem("ulpin-theme") || "dark",
      activeView: "3d",
      legendClass: null,
      sceneReady: false,
      weatherByParcel: {},
      siteRanking: [],
      blueprint: { open: false, plan: null, hoverRoom: null, selectedRoom: null, scale: 1, panX: 0, panY: 0, dragging: false, moved: false, lastX: 0, lastY: 0 }
    };
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const motion = { enabled: !reducedMotion.matches, viewportActive: false, orbit: !reducedMotion.matches, scan: true, speed: 1, exploded: false, time: 100 };

    const $ = (id) => document.getElementById(id);
    const isAdmin = document.body.dataset.role === "ADMIN";
    const USE_COLORS = {
      Retail: 0xffc857,
      Office: 0x39c8f2,
      "Co-working": 0x8e7dff,
      Training: 0xff7f50,
      "Terrace Utility": 0x42d98f,
      Lobby: 0xf6f0cf,
      Residential: 0x6ee7b7,
      Amenities: 0xf78fb3,
      "Public Service": 0xf472b6,
      Dispatch: 0xff9f43,
      "Light Industrial": 0x9ba8ff,
      "R&D": 0x55d6be,
      Storage: 0xb4c6d9,
      Utilities: 0xffd166,
      Cultivation: 0x84cc16
    };
    const TYPE_COLORS = {
      Commercial: 0x39c8f2,
      Residential: 0x42d98f,
      Industrial: 0xff9f43,
      "Mixed-Use": 0x8e7dff,
      Public: 0xf472b6,
      Institutional: 0x55d6be,
      Agricultural: 0x84cc16
    };
    const toCssHex = (hex) => `#${hex.toString(16).padStart(6, "0")}`;
    const colorForFloor = (floor, parcel, floorIndex = 0) =>
      USE_COLORS[floor?.usage] || TYPE_COLORS[floor?.usage] || [0x39c8f2, 0x42d98f, 0x8e7dff][floorIndex % 3];
    const colorForParcel = (parcel) => TYPE_COLORS[parcel?.land_use] || 0x39c8f2;
    const buildingHeight = parcel => Math.max(0, ...parcel.buildings.map(b => b.position.y + b.height));

    function escapeHtml(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    async function api(url, options = {}) {
      const response = await fetch(url, {
        ...options,
        headers: { "Content-Type": "application/json", "X-CSRF-Token": document.body.dataset.csrf, ...(options.headers || {}) }
      });
      if (response.status === 401) window.location.replace("/login");
      if (!response.ok) {
        let detail = "Request failed";
        try {
          const data = await response.json();
          detail = data.detail || detail;
        } catch (_) {}
        throw new Error(detail);
      }
      return response.json();
    }


    function loadExternalScript(url) {
      return new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = url;
        script.async = true;
        script.onload = () => resolve(url);
        script.onerror = () => {
          script.remove();
          reject(new Error(`Failed to load ${url}`));
        };
        document.head.appendChild(script);
      });
    }

    async function ensureThreeDependencies() {
      const threeCandidates = [
        "https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js",
        "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js",
        "https://unpkg.com/three@0.128.0/build/three.min.js"
      ];

      const orbitCandidates = [
        "https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js",
        "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/examples/js/controls/OrbitControls.js",
        "https://unpkg.com/three@0.128.0/examples/js/controls/OrbitControls.js"
      ];

      if (typeof window.THREE === "undefined") {
        let loaded = false;
        for (const url of threeCandidates) {
          try {
            await loadExternalScript(url);
            if (typeof window.THREE !== "undefined") {
              loaded = true;
              break;
            }
          } catch (_) {}
        }
        if (!loaded) {
          throw new Error(
            "Three.js could not be loaded from any CDN. Check internet access, browser extensions, firewall, or CDN blocking."
          );
        }
      }

      if (typeof window.THREE.OrbitControls !== "function") {
        let loaded = false;
        for (const url of orbitCandidates) {
          try {
            await loadExternalScript(url);
            if (typeof window.THREE.OrbitControls === "function") {
              loaded = true;
              break;
            }
          } catch (_) {}
        }
        if (!loaded) {
          throw new Error(
            "OrbitControls could not be loaded. Three.js loaded, but the camera-control dependency was blocked."
          );
        }
      }
    }

    function showViewportError(error) {
      const viewport = $("viewport");
      const old = $("viewportError");
      if (old) old.remove();

      const box = document.createElement("div");
      box.id = "viewportError";
      box.style.cssText = [
        "position:absolute",
        "left:50%",
        "top:50%",
        "transform:translate(-50%,-50%)",
        "z-index:20",
        "width:min(560px,calc(100% - 40px))",
        "padding:18px",
        "border:1px solid rgba(255,101,119,.45)",
        "border-radius:14px",
        "background:rgba(20,7,12,.92)",
        "color:#fff",
        "font:13px/1.55 system-ui,sans-serif",
        "box-shadow:0 18px 50px rgba(0,0,0,.35)"
      ].join(";");

      box.innerHTML = `
        <div style="font-weight:800;color:#ff8291;margin-bottom:7px">3D renderer failed to start</div>
        <div style="opacity:.88">${escapeHtml(error?.message || String(error))}</div>
        <div style="opacity:.62;margin-top:8px;font-size:11px">
          Open DevTools → Console for the underlying browser error.
        </div>
      `;
      viewport.appendChild(box);
    }

    function assertWebGLAvailable() {
      const canvas = document.createElement("canvas");
      const gl =
        canvas.getContext("webgl2") ||
        canvas.getContext("webgl") ||
        canvas.getContext("experimental-webgl");

      if (!gl) {
        throw new Error(
          "WebGL is unavailable in this browser. Enable hardware acceleration in Chrome and restart the browser."
        );
      }
    }

    function toast(message, tone = "info") {
      const el = document.createElement("div");
      el.className = "toast";
      const icon = tone === "success" ? "circle-check" : tone === "danger" ? "triangle-alert" : "info";
      el.innerHTML = `<div class="flex items-start gap-2"><i data-lucide="${icon}" width="14" height="14"></i><div>${escapeHtml(message)}</div></div>`;
      $("toastWrap").appendChild(el);
      lucide.createIcons({ nodes: [el] });
      setTimeout(() => {
        el.style.opacity = "0";
        el.style.transform = "translateY(8px)";
        el.style.transition = ".2s ease";
        setTimeout(() => el.remove(), 220);
      }, 3400);
    }

    function updateClock() {
      const now = new Date();
      $("systemClock").textContent = now.toLocaleTimeString([], { hour12: false });
      $("systemClock").dateTime = now.toISOString();
    }

    function applyTheme() {
      document.body.classList.toggle("light-theme", state.theme === "light");
      $("themeToggle").setAttribute("aria-pressed", state.theme === "light" ? "true" : "false");
      $("themeToggle").querySelector(".theme-knob").innerHTML =
        state.theme === "light"
          ? '<i data-lucide="sun" width="12" height="12"></i>'
          : '<i data-lucide="moon" width="12" height="12"></i>';
      localStorage.setItem("ulpin-theme", state.theme);
      lucide.createIcons();
      if (state.sceneReady) updateSceneTheme();
    }

    const savedSplit = Number.parseFloat(localStorage.getItem("ulpin-workspace-split"));
    const splitLayout = {
      controlPct: Number.isFinite(savedSplit) ? savedSplit : 42,
      currentPct: Number.isFinite(savedSplit) ? savedSplit : 42,
      collapsed: localStorage.getItem("ulpin-workspace-collapsed") === "true",
      dragging: false,
      splitterPx: 12,
      animationTimer: null,
      resizeAnimationFrame: null
    };

    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value));
    }

    function updateSplitControls() {
      const collapsed = splitLayout.collapsed;
      const splitter = $("panelSplitter");
      const toggle = $("splitToggle");
      const expandBtn = $("expandSpatialView");
      if (splitter) splitter.setAttribute("aria-valuenow", String(Math.round(splitLayout.currentPct)));
      if (toggle) {
        toggle.setAttribute("aria-label", collapsed ? "Show parcel panel" : "Collapse parcel panel");
        toggle.title = collapsed ? "Show parcel panel" : "Collapse parcel panel";
        toggle.innerHTML = collapsed
          ? '<i data-lucide="panel-left-open" width="14" height="14"></i>'
          : '<i data-lucide="panel-left-close" width="14" height="14"></i>';
        if (window.lucide) lucide.createIcons({ nodes: [toggle] });
      }
      if (expandBtn) {
        expandBtn.setAttribute("aria-pressed", collapsed ? "true" : "false");
        expandBtn.innerHTML = collapsed
          ? '<i data-lucide="panel-left-open" width="13" height="13"></i><span>Controls</span>'
          : '<i data-lucide="panel-left-close" width="13" height="13"></i><span>Expand</span>';
        if (window.lucide) lucide.createIcons({ nodes: [expandBtn] });
      }
    }

    function persistWorkspaceSplit() {
      localStorage.setItem("ulpin-workspace-split", String(Math.round(splitLayout.currentPct * 10) / 10));
      localStorage.setItem("ulpin-workspace-collapsed", String(splitLayout.collapsed));
    }

    function animateSceneResize() {
      cancelAnimationFrame(splitLayout.resizeAnimationFrame);
      const startedAt = performance.now();
      const tick = now => {
        if (typeof scheduleResize3D === "function") scheduleResize3D();
        if (now - startedAt < 380) splitLayout.resizeAnimationFrame = requestAnimationFrame(tick);
      };
      splitLayout.resizeAnimationFrame = requestAnimationFrame(tick);
    }

    function setListCollapsed(collapsed, animate = true) {
      const workspace = document.querySelector(".workspace");
      if (!workspace || window.matchMedia("(max-width: 1180px)").matches) return;
      splitLayout.collapsed = collapsed;
      hideFloorContextMenu();
      workspace.classList.toggle("list-collapsed", collapsed);
      workspace.classList.toggle("layout-animating", animate);
      updateSplitControls();
      persistWorkspaceSplit();
      if (animate) {
        animateSceneResize();
        clearTimeout(splitLayout.animationTimer);
        splitLayout.animationTimer = setTimeout(() => {
          workspace.classList.remove("layout-animating");
          scheduleResize3D?.();
        }, 380);
      } else {
        scheduleResize3D?.();
      }
    }

    function applyWorkspaceSplit(percent, { animate = false, resizeScene = true } = {}) {
      const workspace = document.querySelector(".workspace");
      if (!workspace || window.matchMedia("(max-width: 1180px)").matches) return;

      const rect = workspace.getBoundingClientRect();
      const available = Math.max(1, rect.width);
      const minLeft = Math.min(520, Math.max(380, available * 0.28));
      const minRight = Math.min(360, Math.max(300, available * 0.24));
      const desiredLeft = available * (percent / 100);
      const leftPx = clamp(desiredLeft, minLeft, available - splitLayout.splitterPx - minRight);
      splitLayout.currentPct = (leftPx / available) * 100;

      clearTimeout(splitLayout.animationTimer);
      if (animate) {
        workspace.classList.add("layout-animating");
        workspace.getBoundingClientRect();
      } else {
        workspace.classList.remove("layout-animating");
      }
      workspace.style.setProperty("--control-panel-width", `${Math.round(leftPx)}px`);
      updateSplitControls();

      if (resizeScene && typeof scheduleResize3D === "function") {
        if (animate) {
          splitLayout.animationTimer = setTimeout(() => {
            workspace.classList.remove("layout-animating");
            scheduleResize3D();
          }, 360);
        } else {
          scheduleResize3D();
        }
      }
    }

    function setWorkspaceMode(mode, animate = true) {
      setListCollapsed(mode === "spatial", animate);
    }

    function toggleWorkspaceMode() {
      setListCollapsed(!splitLayout.collapsed, true);
    }

    function bindWorkspaceSplitter() {
      const workspace = document.querySelector(".workspace");
      const splitter = $("panelSplitter");
      const toggle = $("splitToggle");
      const expandBtn = $("expandSpatialView");
      if (!workspace || !splitter) return;

      const beginDrag = event => {
        if (event.target.closest("button")) return;
        if (window.matchMedia("(max-width: 1180px)").matches) return;
        if (splitLayout.collapsed) setListCollapsed(false, false);
        splitLayout.dragging = true;
        workspace.classList.add("split-dragging");
        splitter.setPointerCapture?.(event.pointerId);
        event.preventDefault();
      };

      const drag = event => {
        if (!splitLayout.dragging) return;
        const rect = workspace.getBoundingClientRect();
        const leftPx = event.clientX - rect.left;
        const pct = (leftPx / Math.max(1, rect.width)) * 100;
        applyWorkspaceSplit(clamp(pct, 28, 72), { animate: false, resizeScene: false });
        scheduleResize3D?.();
      };

      const endDrag = event => {
        if (!splitLayout.dragging) return;
        splitLayout.dragging = false;
        workspace.classList.remove("split-dragging");
        try { splitter.releasePointerCapture?.(event.pointerId); } catch (_) {}
        updateSplitControls();
        persistWorkspaceSplit();
        if (typeof scheduleResize3D === "function") scheduleResize3D();
      };

      splitter.addEventListener("pointerdown", beginDrag);
      splitter.addEventListener("pointermove", drag);
      splitter.addEventListener("pointerup", endDrag);
      splitter.addEventListener("pointercancel", endDrag);
      splitter.addEventListener("dblclick", event => {
        if (event.target.closest("button")) return;
        toggleWorkspaceMode();
      });
      splitter.addEventListener("keydown", event => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          if (splitLayout.collapsed) setListCollapsed(false, false);
          const delta = event.key === "ArrowLeft" ? -2 : 2;
          applyWorkspaceSplit(clamp(splitLayout.currentPct + delta, 28, 72), { animate: true });
          persistWorkspaceSplit();
        } else if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (splitLayout.collapsed) setListCollapsed(false, false);
          applyWorkspaceSplit(50, { animate: true });
          persistWorkspaceSplit();
        }
      });

      toggle?.addEventListener("click", event => {
        event.stopPropagation();
        toggleWorkspaceMode();
      });
      expandBtn?.addEventListener("click", toggleWorkspaceMode);

      const shouldRestoreCollapsed = splitLayout.collapsed;
      applyWorkspaceSplit(splitLayout.controlPct, { animate: false });
      setListCollapsed(shouldRestoreCollapsed, false);
    }

    function switchTab(name) {
      if (!$(`tab-${name}`)) return;
      updateWorkflowNav(name);
      document.querySelectorAll(".tab-pane").forEach(pane => pane.classList.remove("active"));
      $(`tab-${name}`).classList.add("active");
      $("faqBtn")?.setAttribute("aria-pressed", name === "faq" ? "true" : "false");

    }

    function updateWorkflowNav(activeTab = null) {
      const tabName = activeTab || document.querySelector(".tab-pane.active")?.id?.replace(/^tab-/, "") || "land";
      document.querySelectorAll(".tab-btn").forEach(btn => {
        const active = btn.dataset.tab === tabName && (!btn.dataset.intelJump || (tabName === "land" && btn.dataset.intelJump === land.view));
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-selected", active ? "true" : "false");
      });
    }

    function activateLandView(view) {
      if (!view) return;
      land.view = view;
      document.querySelectorAll("[data-intel]").forEach(button => {
        const active = button.dataset.intel === view;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", String(active));
      });
      renderLandInsights();
      updateWorkflowNav("land");
    }

    function visibleConflicts() {
      const ids = new Set(state.sceneParcels.map(p => p.id));
      return state.preflightOverlaps.filter(c => ids.has(c.parcel_a) && ids.has(c.parcel_b));
    }

    function rankSceneParcels() {
      state.siteRanking = state.sceneParcels.map(p => ({id: p.id, ...siteParcelScore(p)})).sort((a, b) => b.score - a.score);
    }

    function setSceneLocation(areaId, {parcelId = null, resetLand = true} = {}) {
      const changed = state.activeAreaId !== areaId;
      if (!changed && !parcelId) return;
      if (!changed && state.selectedParcel?.id === parcelId) return;
      if (changed) {
        state.activeAreaId = areaId;
        if ($("landArea").value) $("landArea").value = areaId || "";
        state.locationRevision++;
        state.sceneParcels = state.parcels.filter(p => p.area_id === areaId);
        state.selectedParcel = null;
        state.selectedFloor = null;
        state.overlap = null;
        clearConflictVolume();
        closePropertyCard();
        $("geometryConsole").replaceChildren();
      }
      const p = state.sceneParcels.find(p => p.id === parcelId) || state.selectedParcel || state.sceneParcels[0];
      state.selectedParcel = p || null;
      state.selectedFloor = p?.floors[0] || null;
      if (changed && state.sceneReady) replaceLocationScene();
      rankSceneParcels();
      if (land.ready && changed && resetLand) {
        land.selected = new Set(p ? [p.id] : []);
        land.editingId = null;
        $("landPackage").value = "";
        landSelectionChanged();
      }
      renderSelectedParcel();
      renderFloorList();
      renderFloorMetrics();
      renderVerificationTarget();
      renderAllInsights();
      updateSelectionChip();
      updateParcelWeatherPanel(p);
      if (state.sceneReady) renderStillFrame();
    }

    function showSearchLocation(items) {
      const area = items.some(p => p.area_id === state.activeAreaId) ? state.activeAreaId : items[0]?.area_id || null;
      const first = items.find(p => p.area_id === area);
      setSceneLocation(area, {parcelId: first?.id});
    }

    function populateFilters() {
      const states = [...new Set(state.parcels.map(p => p.state))].sort();
      const districts = [...new Set(state.parcels.map(p => p.district))].sort();
      $("stateFilter").innerHTML = '<option value="">All States</option>' + states.map(s => `<option>${escapeHtml(s)}</option>`).join("");
      $("districtFilter").innerHTML = '<option value="">All Districts</option>' + districts.map(s => `<option>${escapeHtml(s)}</option>`).join("");
    }

    function floorStats() {
      const floors = state.sceneParcels.flatMap(p => p.floors.map(f => ({ ...f, parcel: p })));
      const verified = floors.filter(f => f.verification_status === "Verified").length;
      const review = floors.length - verified;
      const totalArea = floors.reduce((n, f) => n + f.area_sqm, 0);
      return {
        floors,
        verified,
        review,
        totalArea,
        verifiedPct: floors.length ? Math.round((verified / floors.length) * 100) : 0
      };
    }

    function kpi(label, value, sub, tone = "#39c8f2") {
      return `<div class="kpi-card" style="--tone:${tone}"><div class="kpi-label">${escapeHtml(label)}</div><div class="kpi-value">${escapeHtml(value)}</div><div class="kpi-sub">${escapeHtml(sub)}</div></div>`;
    }

    function renderDashboard() {
      const stats = floorStats();
      const conflictCount = state.overlap ? 1 : 0;
      const preflightCount = visibleConflicts().length;
      $("dashboardKPIs").innerHTML = [
        kpi("Verified coverage", `${stats.verifiedPct}%`, `${stats.verified} of ${stats.floors.length} vertical units`, "#42d98f"),
        kpi("Overlap signals", String(conflictCount || preflightCount), conflictCount ? `${state.overlap.overlap_percent.toFixed(1)}% checked conflict` : `${preflightCount} preflight volumes visible`, conflictCount ? "#ff5c7a" : "#ffc857"),
        kpi("Registered area", `${(state.sceneParcels.reduce((sum, p) => sum + p.area_ha, 0) * 10).toFixed(1)}k m2`, "Parcel land area", "#ffc857"),
        ...(isAdmin ? [kpi("Review queue", String(stats.review), "Pending or officer-reviewed floors", stats.review ? "#8e7dff" : "#42d98f")] : [])
      ].join("");
      $("readinessPct").textContent = `${stats.verifiedPct}%`;
      $("readinessBar").style.width = `${stats.verifiedPct}%`;
      $("readinessText").textContent = `${state.sceneParcels.length} parcels indexed, ${stats.floors.length} vertical property units.` + (isAdmin ? ` ${stats.review} units still needing final verification.` : "");
      const trend = [3, 5, 4, 7, 6, 8, 5, 9];
      const months = ["Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep"];
      const max = Math.max(...trend);
      $("trendBars").innerHTML = trend.map((v, i) => `<div class="trend-bar" style="height:${Math.max(14, v / max * 88)}px"><span>${months[i]}</span></div>`).join("");
      const pending = isAdmin ? stats.floors.filter(f => f.verification_status !== "Verified").slice(0, 3) : [];
      $("attentionList").innerHTML = [
        state.overlap ? `<div class="attention-item"><strong>${escapeHtml(state.overlap.id)}</strong><span>${escapeHtml(state.overlap.message)}</span></div>` : `<div class="attention-item"><strong>${preflightCount} preflight overlap signals</strong><span>Open the Conflict Workbench to inspect the highlighted risk volumes before running a check.</span></div>`,
        ...pending.map(f => `<div class="attention-item"><strong>${escapeHtml(f.parcel.id)} / ${escapeHtml(f.name)}</strong><span>${escapeHtml(f.verification_status)} - ${escapeHtml(f.ulpin)}</span></div>`)
      ].join("");
    }

    function renderRegistry() {
      const items = state.parcels.length ? state.filteredParcels : [];
      $("registryCount").textContent = `${items.length} records`;
      $("registryRows").innerHTML = items.length ? items.map(p => `
        <div class="registry-row ${state.selectedParcel?.id === p.id ? "selected" : ""}" data-registry-parcel="${escapeHtml(p.id)}" style="--row-accent:${toCssHex(colorForParcel(p))}">
          <div class="registry-row-grid">
            <div><strong>${escapeHtml(p.parcel_display_ulpin)}</strong><span>${escapeHtml(p.district)}, ${escapeHtml(p.state)} - ${escapeHtml(p.survey_no)}</span></div>
            <span class="pill">${escapeHtml(p.land_use)}</span>
          </div>
        </div>
      `).join("") : '<div class="attention-item"><strong>No registry matches</strong><span>Broaden the parcel filters on the dashboard panel.</span></div>';
      document.querySelectorAll("[data-registry-parcel]").forEach(el => {
        el.addEventListener("click", () => selectParcelById(el.dataset.registryParcel, true));
      });
      renderMiniMap(items);
      renderRegistryInspector();
    }

    function renderMiniMap(items) {
      if (!items.length) {
        $("mapPins").innerHTML = '<div class="section-kicker p-3">No coordinates in the current filtered view.</div>';
        return;
      }
      const lats = items.map(p => p.centroid.lat);
      const lons = items.map(p => p.centroid.lon);
      const minLat = Math.min(...lats), maxLat = Math.max(...lats);
      const minLon = Math.min(...lons), maxLon = Math.max(...lons);
      $("mapPins").innerHTML = items.map(p => {
        const x = 12 + ((p.centroid.lon - minLon) / Math.max(0.00001, maxLon - minLon)) * 76;
        const y = 88 - ((p.centroid.lat - minLat) / Math.max(0.00001, maxLat - minLat)) * 76;
        return `<button class="map-pin" data-registry-parcel="${escapeHtml(p.id)}" title="${escapeHtml(p.id)}" style="left:${x}%;top:${y}%;--pin:${toCssHex(colorForParcel(p))}"></button>`;
      }).join("");
      document.querySelectorAll(".map-pin").forEach(el => {
        el.addEventListener("click", () => selectParcelById(el.dataset.registryParcel, true));
      });
    }

    function renderRegistryInspector() {
      const p = state.selectedParcel;
      if (!p) {
        $("registrySelectedStatus").textContent = "No selection";
        $("registryInspector").replaceChildren();
        return;
      }
      $("registrySelectedStatus").textContent = p.status;
      $("registryInspector").innerHTML = `
        <div class="metric"><div class="metric-label">Owner</div><div class="metric-value">${escapeHtml(p.floors[0]?.owner_id || "Masked")}</div></div>
        <div class="metric"><div class="metric-label">Survey</div><div class="metric-value">${escapeHtml(p.survey_no)}</div></div>
        <div class="metric"><div class="metric-label">Area</div><div class="metric-value">${p.registered_area_sqft.toLocaleString()} ft2</div></div>
        <div class="metric"><div class="metric-label">Centroid</div><div class="metric-value">${p.centroid.lat.toFixed(5)}, ${p.centroid.lon.toFixed(5)}</div></div>
      `;
    }

    function renderOverlapPreview() {
      const items = visibleConflicts().sort((a, b) => {
        const selected = state.selectedParcel?.id;
        const aSelected = selected && (a.parcel_a === selected || a.parcel_b === selected) ? 1 : 0;
        const bSelected = selected && (b.parcel_a === selected || b.parcel_b === selected) ? 1 : 0;
        return bSelected - aSelected || b.overlap_percent - a.overlap_percent;
      });
      if (!items.length) {
        $("overlapPreviewBody").innerHTML = "No preflight overlap signals are available.";
        return;
      }
      const top = items.slice(0, 3);
      const selectedHit = items.find(item => state.selectedParcel?.id && (item.parcel_a === state.selectedParcel.id || item.parcel_b === state.selectedParcel.id));
      $("overlapPreviewBody").innerHTML = `
        ${selectedHit
          ? `Selected parcel intersects <strong>${escapeHtml(selectedHit.parcel_a === state.selectedParcel.id ? selectedHit.parcel_b : selectedHit.parcel_a)}</strong> at <strong>${selectedHit.overlap_percent.toFixed(1)}%</strong>.`
          : `${items.length} suspected boundary overlaps are already highlighted in the 3D view.`}
        <div class="overlap-preview-list">
          ${top.map(item => `
            <div class="overlap-preview-item">
              <div><strong>${escapeHtml(item.parcel_a)} vs ${escapeHtml(item.parcel_b)}</strong><span>${escapeHtml(item.severity)} preflight signal</span></div>
              <b>${item.overlap_percent.toFixed(1)}%</b>
            </div>
          `).join("")}
        </div>
      `;
    }

    function renderConflictWorkbench() {
      const conflict = state.overlap;
      renderOverlapPreview();
      $("conflictStats").innerHTML = [
        kpi("Active cases", conflict ? "1" : "0", conflict ? `${conflict.parcel_a} vs ${conflict.parcel_b}` : `${visibleConflicts().length} preflight signals`, conflict ? "#ff5c7a" : "#ffc857"),
        kpi("Overlap exposure", conflict ? `${conflict.overlap_percent.toFixed(1)}%` : `${Math.max(0, ...visibleConflicts().map(item => item.overlap_percent)).toFixed(1)}%`, conflict ? "Checked geometry signal" : "Highest preflight signal", "#ffc857")
      ].join("");
      $("workflowStatus").textContent = conflict ? conflict.severity : "waiting";
      $("conflictWorkflow").innerHTML = [
        ["Conflict detected", !!conflict],
        ["Joint re-survey recommendation", state.selectedFloor?.verification_status === "Re-Survey Requested"],
        ["Officer conflict flag recorded", state.selectedFloor?.verification_status === "Conflict Flagged"],
        ["Resolution decision / property card", state.selectedFloor?.verification_status === "Verified"]
      ].map(([label, done]) => `<div class="workflow-step"><i>${done ? "✓" : "○"}</i><span>${escapeHtml(label)}</span></div>`).join("");
      if (!conflict) {
        $("conflictCompare").innerHTML = `<div class="attention-item"><strong>No active generated case</strong><span>Run the overlap check to compare two records and render the conflict volume in 3D.</span></div>`;
        return;
      }
      const a = state.parcels.find(p => p.id === conflict.parcel_a);
      const b = state.parcels.find(p => p.id === conflict.parcel_b);
      $("conflictCompare").innerHTML = [a, b].filter(Boolean).map(p => `
        <div class="chart-card">
          <div class="chart-title">${escapeHtml(p.id)}</div>
          <strong>${escapeHtml(p.parcel_display_ulpin)}</strong>
          <div class="kpi-sub">${escapeHtml(p.district)}, ${escapeHtml(p.state)} - ${escapeHtml(p.land_use)}</div>
          <div class="hbar"><span style="width:${Math.min(100, p.floors.length * 14)}%;--bar:${toCssHex(colorForParcel(p))}"></span></div>
          <div class="kpi-sub">${p.floors.length} floors - ${p.registered_area_sqft.toLocaleString()} ft2 - ${escapeHtml(p.status)}</div>
        </div>
      `).join("");
    }

    function renderAnalytics() {
      const stats = floorStats();
      const avgArea = stats.floors.length ? stats.totalArea / stats.floors.length : 0;
      const buildings = state.sceneParcels.flatMap(p => p.buildings);
      const avgFloors = buildings.length ? buildings.reduce((sum, b) => sum + b.floors.length, 0) / buildings.length : 0;
      $("analyticsCards").innerHTML = [
        kpi("Average unit", `${avgArea.toFixed(0)} m2`, "Mean vertical unit area", "#39c8f2"),
        kpi("Average built form", `${avgFloors.toFixed(1)} floors`, "Across buildings", "#8e7dff"),
        kpi("Conflict exposure", state.overlap ? `${state.overlap.overlap_percent.toFixed(1)}%` : "0%", "Current generated case", state.overlap ? "#ff5c7a" : "#42d98f"),
        kpi("Latest trend", "9 units", "Synthetic Sep verification pace", "#ffc857")
      ].join("");
      const byType = Object.entries(state.sceneParcels.reduce((acc, p) => (acc[p.land_use] = (acc[p.land_use] || 0) + p.area_ha, acc), {}));
      const byStatus = Object.entries(stats.floors.reduce((acc, f) => (acc[f.verification_status] = (acc[f.verification_status] || 0) + 1, acc), {}));
      $("analyticsCharts").innerHTML = [
        chartBlock("Land use by parcel area (ha)", byType.map(([name, area]) => [name, Number(area.toFixed(3))]), (name) => toCssHex(TYPE_COLORS[name] || 0x39c8f2)),
        chartBlock("Verification status mix", byStatus, (name) => name === "Verified" ? "#42d98f" : name.includes("Conflict") ? "#ff5c7a" : "#ffc857"),
        chartBlock("Registered area by parcel", state.sceneParcels.map(p => [p.id, Math.round(p.registered_area_sqft / 100)]), (name) => toCssHex(colorForParcel(state.parcels.find(p => p.id === name)))),
        chartBlock("Building floors by parcel", state.sceneParcels.map(p => [p.id, p.buildings.reduce((sum, b) => sum + b.floors.length, 0)]), () => "#8e7dff")
      ].join("");
    }

    function chartBlock(title, rows, colorFn) {
      const max = Math.max(1, ...rows.map(([, v]) => v));
      return `<div class="chart-card"><div class="chart-title">${escapeHtml(title)}</div>${rows.map(([name, value]) => `
        <div class="kpi-sub">${escapeHtml(name)} <strong>${value}</strong></div>
        <div class="hbar"><span style="width:${Math.max(5, value / max * 100)}%;--bar:${colorFn(name)}"></span></div>
      `).join("")}</div>`;
    }

    function renderCertificatePreview() {
      const p = state.selectedParcel;
      const f = state.selectedFloor;
      if (!p || !f) {
        $("certificateCheck")?.replaceChildren();
        $("certificatePreview")?.replaceChildren();
        return;
      }
      const statusTone = f.verification_status === "Verified" ? "success" : f.verification_status.includes("Conflict") ? "danger" : "warning";
      $("certificateCheck")?.replaceChildren();
      if ($("certificateCheck")) {
        $("certificateCheck").innerHTML = `
          <div class="attention-item"><strong>ULPIN identity present</strong><span>${escapeHtml(f.ulpin)}</span></div>
          <div class="attention-item"><strong>Geometry fields present</strong><span>${f.area_sqm.toLocaleString()} m2 at ${p.centroid.lat.toFixed(5)}, ${p.centroid.lon.toFixed(5)}</span></div>
        `;
      }
      if ($("certificatePreview")) {
        $("certificatePreview").innerHTML = `
          <div class="watermark-mini">SPECIMEN - PROTOTYPE DOCUMENT - NOT FOR LEGAL USE</div>
          <div style="font-size:10px;font-weight:900;letter-spacing:.12em;color:#06728f;margin-top:14px;">ULPIN 3D CADASTRE</div>
          <div style="font-size:22px;font-weight:900;margin-top:3px;">Specimen Vertical Property Extract</div>
          <div style="font-size:11px;color:#64748b;margin-top:2px;">Synthetic register - current UI state</div>
          <div style="border-top:2px solid #0f4963;margin:13px 0;"></div>
          <table style="width:100%;font-size:11px;line-height:1.7;">
            <tr><td>Parcel</td><td><strong>${escapeHtml(p.id)}</strong></td></tr>
            <tr><td>Floor</td><td>${escapeHtml(f.name)} - ${escapeHtml(f.usage)}</td></tr>
            <tr><td>ULPIN</td><td>${escapeHtml(f.ulpin)}</td></tr>
            <tr><td>Status</td><td>${escapeHtml(f.verification_status)}</td></tr>
            <tr><td>Owner</td><td>${escapeHtml(f.owner_id)}</td></tr>
            <tr><td>Survey</td><td>${escapeHtml(p.survey_no)}</td></tr>
          </table>
          <div class="kpi-sub ${statusTone}" style="margin-top:12px;color:#64748b;">Use the approval action below to issue the functional backend property card modal.</div>
        `;
      }
    }

    function renderAllInsights() {
      renderDashboard();
      renderRegistry();
      renderConflictWorkbench();
      renderAnalytics();
      renderCertificatePreview();
      renderSceneSummary();
      lucide.createIcons();
    }

    function renderSceneSummary() {
      const disputed = state.sceneParcels.filter(p => p.status.includes("Disputed")).length;
      const selected = state.sceneParcels.filter(p => land.selected.has(p.id)).length;
      $("sceneSummary").innerHTML = `<span>${escapeHtml(state.sceneParcels[0]?.district || "No location")}</span><span><b>${state.sceneParcels.length}</b> parcels</span><span><i style="--signal:#ffe077"></i><b>${selected}</b> selected</span><span><i style="--signal:#ff6577"></i><b>${disputed}</b> disputed</span>`;
      renderSpatialLegend();
    }

    function renderSpatialLegend() {
      const counts = new Map();
      state.sceneParcels.forEach(p => {
        const key = sceneVisuals.classification(p);
        counts.set(key, (counts.get(key) || 0) + 1);
      });
      if (state.legendClass && !counts.has(state.legendClass)) state.legendClass = null;
      $("legendTotal").textContent = `${state.sceneParcels.length} parcels`;
      $("legendClasses").innerHTML = sceneVisuals.classifications.map(c => `
        <button type="button" class="legend-row" data-legend-class="${c.id}"
          aria-pressed="${state.legendClass === c.id}" ${counts.has(c.id) ? "" : "disabled"}
          title="Highlight ${c.label.toLowerCase()} parcels" style="--class-color:${toCssHex(c.color)}">
          <span class="swatch" style="background:var(--class-color)"></span><span>${c.label}</span><b>${counts.get(c.id) || 0}</b>
        </button>`).join("");
      $("legendConflicts").textContent = visibleConflicts().length;
      $("legendSelected").textContent = state.sceneParcels.filter(p => land.selected.has(p.id)).length;
    }

    function updateSelectionChip(parcel = state.selectedParcel, floor = state.selectedFloor, building = undefined) {
      drawPropertyQr(parcel);
      $("selectionChip").classList.remove("overlap-alert");
      if (!parcel || !floor) {
        $("selectionChip").textContent = "No parcel selected";
        return;
      }
      const structure = building === undefined ? parcel.buildings.find(b => b.floors.some(f => f.id === floor.id)) : building;
      const description = structure ? structure.type : parcel.agriculture
        ? `${parcel.agriculture.crop} / ${parcel.agriculture.cultivation_status} / ${parcel.area_ha} ha`
        : `${parcel.land_use} land / ${parcel.area_ha} ha`;
      $("selectionChip").innerHTML = `<strong>${escapeHtml(parcel.id)} / ${escapeHtml(floor.name)}</strong><br>${escapeHtml(description)} &middot; ${escapeHtml(floor.verification_status)}<br><span class="floor-code">${escapeHtml(floor.usage)} / ${escapeHtml(floor.ulpin)}</span>`;
    }

    function downloadFile(filename, content, type) {
      const blob = new Blob([content], { type });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    }

    function renderParcelResults(items) {
      $("parcelCount").textContent = `${items.length} record${items.length === 1 ? "" : "s"}`;
      $("parcelResults").innerHTML = items.length ? items.map(p => `
        <button class="parcel-card w-full text-left ${state.selectedParcel?.id === p.id ? "selected" : ""}" data-parcel-id="${escapeHtml(p.id)}" style="--parcel-accent:${toCssHex(colorForParcel(p))}">
          <div class="parcel-top">
            <div>
              <div class="parcel-title">${escapeHtml(p.id)} · ${escapeHtml(p.land_use)}</div>
              <div class="parcel-meta">${escapeHtml(p.district)}, ${escapeHtml(p.state)}<br/>Survey ${escapeHtml(p.survey_no)}</div>
            </div>
            <span class="pill">${escapeHtml(p.state_code)}</span>
          </div>
          <div class="mt-2 flex gap-2 flex-wrap">
            <span class="pill">${p.floors.length} vertical units</span>
            <span class="pill">${escapeHtml(p.status)}</span>
            <span class="pill">Site score ${siteParcelScore(p).score}/100</span>
          </div>
        </button>
      `).join("") : '<div class="text-[10px] text-[var(--muted)] py-5 text-center">No parcels match the selected filters.</div>';

      document.querySelectorAll("[data-parcel-id]").forEach(el => {
        el.addEventListener("click", () => selectParcelById(el.dataset.parcelId, true));
        el.addEventListener("mouseenter", () => {
          const parcel = state.parcels.find(p => p.id === el.dataset.parcelId);
          if (parcel) updateParcelWeatherPanel(parcel);
        });
      });
      renderRegistry();
      renderDashboard();
    }


    function siteWeatherScore(weather) {
      if (!weather) return { score: 50, label: "Loading" };
      const temp = Number(weather.temperature);
      const rain = Number(weather.precipitation);
      const wind = Number(weather.wind_speed);
      let score = 100;
      // Screening heuristic for general site work; not an engineering or crop model.
      if (Number.isFinite(temp)) {
        if (temp >= 28 && temp <= 34) score += 0;
        else if (temp >= 24 && temp <= 37) score -= 8;
        else score -= 18;
      }
      if (Number.isFinite(rain)) {
        if (rain > 20) score -= 25;
        else if (rain > 8) score -= 12;
      }
      if (Number.isFinite(wind) && wind > 30) score -= 15;
      return { score: Math.max(0, Math.min(100, Math.round(score))), label: score >= 80 ? "Favorable" : score >= 60 ? "Moderate" : "Weather risk" };
    }

    function siteParcelScore(parcel) {
      const soilScore = Number(parcel.soil?.suitability ?? 70);
      const weather = state.weatherByParcel[parcel.id];
      const weatherResult = siteWeatherScore(weather);
      const verification = parcel.status === "Spatially Indexed" ? 95 :
        parcel.status === "Evidence Pending" ? 70 :
        parcel.status === "Under Review" ? 55 :
        parcel.status === "Unverified Intake" ? 40 :
        parcel.status === "Disputed Boundary" ? 25 : 80;
      const conflictPenalty = state.preflightOverlaps.some(x => x.parcel_a === parcel.id || x.parcel_b === parcel.id) ? 15 : 0;
      const score = Math.round((soilScore * 0.35) + (weatherResult.score * 0.35) + (verification * 0.30) - conflictPenalty);
      return { score: Math.max(0, Math.min(100, score)), weather: weatherResult, soilScore, verification, conflictPenalty };
    }

    function renderSiteSelection() {
      const p = state.selectedParcel;
      if (!p) {
        $("siteSelectionSummary").replaceChildren();
        $("siteSelectionNote").textContent = "";
        $("siteSelectionRank").textContent = "No selection";
        return;
      }
      const result = siteParcelScore(p);
      const weather = state.weatherByParcel[p.id];
      const rank = state.siteRanking.findIndex(x => x.id === p.id) + 1;
      $("siteSelectionRank").textContent = rank > 0 ? `#${rank} of ${state.sceneParcels.length}` : "Scoring";
      $("siteSelectionSummary").innerHTML = `
        <div class="metric"><div class="metric-label">Weather</div><div class="metric-value">${weather ? `${weather.temperature.toFixed(1)}°C · ${weather.precipitation.toFixed(1)} mm` : "Loading…"}</div></div>
        <div class="metric"><div class="metric-label">Soil</div><div class="metric-value">${escapeHtml(p.soil?.type || "Regional estimate")}</div></div>
        <div class="metric"><div class="metric-label">Site Score</div><div class="metric-value site-score">${result.score}/100</div></div>
        <div class="metric"><div class="metric-label">Recommendation</div><div class="metric-value site-recommendation">${result.score >= 80 ? "Best choice" : result.score >= 65 ? "Consider" : "Lower priority"}</div></div>
      `;
      $("siteSelectionNote").textContent =
        `${result.weather.label}. Soil screening: ${p.soil?.type || "regional estimate"} (${result.soilScore}/100). ` +
        `Record confidence: ${result.verification}/100${result.conflictPenalty ? "; boundary-overlap penalty applied." : "."} ` +
        `Weather source: ${weather?.source || "loading"}. Soil and screening scores are synthetic, not field measurements.`;
    }

    async function loadSiteWeather() {
      if (!state.parcels.length) return;
      try {
        const payload = await api("/api/intelligence/aggregate", {method: "POST", body: JSON.stringify({parcel_ids: state.parcels.map(p => p.id), provider: "demo"})});
        payload.items.forEach(item => { state.weatherByParcel[item.parcel_id] = item.weather; land.risks[item.parcel_id] = item.risks; });
        rankSceneParcels();
        renderSiteSelection();
        renderParcelResults(state.filteredParcels);
        updateParcelWeatherPanel(hoveredParcel ? state.parcels.find(p => p.id === hoveredParcel.userData.parcelId) : state.selectedParcel);
      } catch (err) {
        console.warn("Site weather unavailable:", err);
        $("siteSelectionNote").textContent = "Live weather could not be loaded. Soil and record-based screening remain available.";
        // Still update the panel so soil data is visible even without weather
        const fallbackParcel = hoveredParcel
          ? state.parcels.find(p => p.id === hoveredParcel.userData.parcelId)
          : state.selectedParcel;
        updateParcelWeatherPanel(fallbackParcel);
      }
    }

    function renderSelectedParcel() {
      const p = state.selectedParcel;
      if (!p) {
        $("parcelStatus").textContent = "No selection";
        $("selectedParcelMetrics").replaceChildren();
        renderSiteSelection();
        return;
      }
      $("parcelStatus").textContent = p.status;
      $("selectedParcelMetrics").innerHTML = `
        <div class="metric"><div class="metric-label">Parcel</div><div class="metric-value">${escapeHtml(p.id)}</div></div>
        <div class="metric"><div class="metric-label">Survey</div><div class="metric-value">${escapeHtml(p.survey_no)}</div></div>
        <div class="metric"><div class="metric-label">Land use</div><div class="metric-value">${escapeHtml(p.land_use)}</div></div>
        <div class="metric"><div class="metric-label">Centroid</div><div class="metric-value">${p.centroid.lat.toFixed(5)}, ${p.centroid.lon.toFixed(5)}</div></div>
      `;
      renderRegistryInspector();
      renderCertificatePreview();
      renderSiteSelection();
    }

    function renderFloorList() {
      const p = state.selectedParcel;
      if (!p) {
        $("floorInspectorSubtitle").textContent = "No parcel selected";
        $("floorList").innerHTML = '<div class="text-[10px] text-[var(--muted)]">No parcel selected.</div>';
        return;
      }
      $("floorInspectorSubtitle").textContent = `${p.id} · ${p.district} · ${p.floors.length} vertical units`;
      $("floorList").innerHTML = p.floors.map((f, idx) => `
        <button class="floor-item ${state.selectedFloor?.id === f.id ? "active" : ""}" data-floor-id="${f.id}" style="--floor-accent:${toCssHex(colorForFloor(f, p, idx))}">
          <div>
            <div class="floor-name">${escapeHtml(f.name)}</div>
            <div class="floor-usage">${escapeHtml(f.usage)} · ${f.area_sqft.toLocaleString()} sq ft</div>
          </div>
          <div class="floor-code">${escapeHtml(f.machine_ulpin)}</div>
        </button>
      `).join("");

      document.querySelectorAll("[data-floor-id]").forEach(el => {
        el.addEventListener("click", () => selectFloor(p.id, el.dataset.floorId, true, true));
      });
    }

    function renderFloorMetrics() {
      const f = state.selectedFloor;
      if (!f) {
        $("floorStatus").textContent = "No floor selected";
        $("floorMetrics").replaceChildren();
        return;
      }
      $("floorStatus").textContent = f.verification_status;
      $("floorMetrics").innerHTML = `
        <div class="metric"><div class="metric-label">ULPIN</div><div class="metric-value">${escapeHtml(f.ulpin)}</div></div>
        <div class="metric"><div class="metric-label">Machine ID</div><div class="metric-value">${escapeHtml(f.machine_ulpin)}</div></div>
        <div class="metric"><div class="metric-label">Owner</div><div class="metric-value">${escapeHtml(f.owner_id)}</div></div>
        <div class="metric"><div class="metric-label">Area</div><div class="metric-value">${f.area_sqft.toLocaleString()} ft² / ${f.area_sqm.toLocaleString()} m²</div></div>
        <div class="metric"><div class="metric-label">Usage</div><div class="metric-value">${escapeHtml(f.usage)}</div></div>
        <div class="metric"><div class="metric-label">Registered</div><div class="metric-value">${escapeHtml(f.registration_date)}</div></div>
      `;
      renderVerificationTarget();
      renderCertificatePreview();
    }

    function renderVerificationTarget() {
      if (!$("verifyTarget")) return;
      const p = state.selectedParcel;
      const f = state.selectedFloor;
      const hasTarget = !!(p && f);
      ["flagBtn", "resurveyBtn", "approveBtn"].forEach(id => $(id).disabled = !hasTarget);
      $("verifyStatus").textContent = f ? f.verification_status : "Waiting";
      if (!hasTarget) { $("verifyTarget").replaceChildren(); return; }
      $("verifyTarget").innerHTML = `
        <div class="metric"><div class="metric-label">Parcel</div><div class="metric-value">${escapeHtml(p.id)}</div></div>
        <div class="metric"><div class="metric-label">Floor</div><div class="metric-value">${escapeHtml(f.name)}</div></div>
        <div class="metric"><div class="metric-label">ULPIN</div><div class="metric-value">${escapeHtml(f.ulpin)}</div></div>
        <div class="metric"><div class="metric-label">Owner</div><div class="metric-value">${escapeHtml(f.owner_id)}</div></div>
      `;
    }

    function selectParcelById(parcelId, focusScene = false) {
      const p = state.parcels.find(x => x.id === parcelId);
      if (!p) return;
      if (p.area_id !== state.activeAreaId) setSceneLocation(p.area_id, {parcelId, resetLand: !$("landMulti").checked});
      state.selectedParcel = p;
      state.selectedFloor = p.floors.find(f => f.id === state.selectedFloor?.id) || p.floors[0];
      landActiveParcel(parcelId);
      state.overlap = null;
      clearConflictVolume();
      renderParcelResults(state.filteredParcels);
      renderSelectedParcel();
      renderFloorList();
      renderFloorMetrics();
      renderAllInsights();
      updateSelectionChip();
      updatePreflightOverlapEmphasis();
      updateParcelWeatherPanel(p);
      if (focusScene) focusParcel(parcelId);
    }

    function selectFloor(parcelId, floorId, focusScene = true, changeTab = false) {
      const p = state.parcels.find(x => x.id === parcelId);
      if (!p) return;
      const f = p.floors.find(x => x.id === floorId);
      if (!f) return;
      if (p.area_id !== state.activeAreaId) setSceneLocation(p.area_id, {parcelId, resetLand: !$("landMulti").checked});
      state.selectedParcel = p;
      state.selectedFloor = f;
      landActiveParcel(parcelId);
      renderParcelResults(state.filteredParcels);
      renderSelectedParcel();
      renderFloorList();
      renderFloorMetrics();
      renderVerificationTarget();
      renderAllInsights();
      isolateFloor(parcelId, floorId);
      updateSelectionChip();
      updatePreflightOverlapEmphasis();
      updateParcelWeatherPanel(p);
      if (focusScene) focusFloor(parcelId, floorId);
      if (changeTab) switchTab("floors");
    }

    async function runSearch() {
      const revision = ++state.searchRevision;
      const params = new URLSearchParams({
        state: $("stateFilter").value,
        district: $("districtFilter").value,
        survey_no: $("surveyFilter").value,
        ulpin: $("ulpinFilter").value
      });
      try {
        const data = await api(`/api/search?${params.toString()}`);
        if (revision !== state.searchRevision) return;
        state.filteredParcels = data.items;
        showSearchLocation(data.items);
        renderParcelResults(data.items);
        renderAllInsights();
      } catch (err) {
        toast(err.message, "danger");
      }
    }

    function clearSearch() {
      state.searchRevision++;
      $("stateFilter").value = "";
      $("districtFilter").value = "";
      $("surveyFilter").value = "";
      $("ulpinFilter").value = "";
      state.filteredParcels = [...state.parcels];
      setSceneLocation("HYD");
      renderParcelResults(state.filteredParcels);
      renderAllInsights();
    }

    function logConsole(text, tone = "") {
      const line = document.createElement("div");
      line.className = tone;
      const time = new Date().toLocaleTimeString([], { hour12: false });
      line.textContent = `[${time}] ${text}`;
      $("geometryConsole").appendChild(line);
      $("geometryConsole").scrollTop = $("geometryConsole").scrollHeight;
    }

    async function executeOverlapCheck() {
      if (!state.selectedParcel) return;
      const parcelId = state.selectedParcel.id;
      const revision = state.locationRevision;
      $("overlapBtn").disabled = true;
      $("overlapBtn").innerHTML = '<i data-lucide="loader-circle" width="14" height="14"></i>Running Geometry Check...';
      lucide.createIcons();
      logConsole(`Loading topology for ${state.selectedParcel.id}...`, "dim");
      logConsole("Computing parcel adjacency graph...");
      await new Promise(r => setTimeout(r, 360));
      logConsole("Extruding vertical title volumes...");
      await new Promise(r => setTimeout(r, 360));
      try {
        const conflict = await api("/api/overlap/check", {
          method: "POST",
          body: JSON.stringify({ parcel_id: parcelId })
        });
        if (revision !== state.locationRevision || state.selectedParcel?.id !== parcelId) return;
        state.overlap = conflict;
        renderConflictVolume(conflict);
        renderAllInsights();
        $("overlapWarning").classList.add("show");
        $("overlapWarningBody").innerHTML = `
          <strong>${escapeHtml(conflict.parcel_a)}</strong> ↔ <strong>${escapeHtml(conflict.parcel_b)}</strong><br>
          Overlap: <strong>${conflict.overlap_percent.toFixed(1)}%</strong> · Severity: <strong>${escapeHtml(conflict.severity)}</strong><br>
          Approx. conflict centroid: ${conflict.centroid.lat.toFixed(6)}, ${conflict.centroid.lon.toFixed(6)}<br>
          ${escapeHtml(conflict.message)}
        `;
        logConsole(`Conflict volume generated: ${conflict.id}`, "bad");
        logConsole(`Overlap ${conflict.overlap_percent.toFixed(1)}% at ${conflict.centroid.lat.toFixed(6)}, ${conflict.centroid.lon.toFixed(6)}`, "warn");
        toast("Spatial overlap detected and visualized.", "danger");
      } catch (err) {
        logConsole(`ERROR: ${err.message}`, "bad");
        toast(err.message, "danger");
      } finally {
        $("overlapBtn").disabled = false;
        $("overlapBtn").innerHTML = '<i data-lucide="scan-search" width="14" height="14"></i>Execute Overlap Check';
        lucide.createIcons();
      }
    }

    async function officerAction(action) {
      if (!state.selectedParcel || !state.selectedFloor) {
        toast("Select a vertical floor first.", "danger");
        return;
      }
      const note = $("officerNote").value.trim();
      const parcel = state.selectedParcel, floor = state.selectedFloor;
      const revision = state.locationRevision;
      try {
        const data = await api(`/api/verify/${encodeURIComponent(parcel.id)}/${encodeURIComponent(floor.id)}`, {
          method: "POST",
          body: JSON.stringify({ action, note })
        });
        const updated = parcel.floors.find(f => f.id === floor.id);
        if (action === "approve") updated.verification_status = "Verified";
        if (action === "flag_conflict") updated.verification_status = "Conflict Flagged";
        if (action === "request_resurvey") updated.verification_status = "Re-Survey Requested";
        if (revision !== state.locationRevision || state.selectedParcel?.id !== parcel.id || state.selectedFloor?.id !== floor.id) { await refreshAudit(); return; }
        state.selectedFloor = updated;
        renderFloorList();
        renderFloorMetrics();
        renderVerificationTarget();
        renderAllInsights();
        toast(data.record.status, action === "approve" ? "success" : "info");
        await refreshAudit();
        if (action === "approve" && data.property_card) openPropertyCard(data.property_card);
      } catch (err) {
        toast(err.message, "danger");
      }
    }

    async function refreshAudit() {
      if (!$("auditList")) return;
      try {
        const data = await api("/api/audit?limit=8");
        $("auditList").innerHTML = data.items.length ? data.items.map(event => `
          <div class="parcel-card !mt-0">
            <div class="font-bold text-[var(--text)]">${escapeHtml(event.status || event.event || "Event")}</div>
            <div class="mt-1">${escapeHtml(event.parcel_id || "")}${event.floor_id ? " · " + escapeHtml(event.floor_id) : ""}</div>
            <div class="mt-1 opacity-70">${escapeHtml(event.timestamp || "")}</div>
          </div>
        `).join("") : "No events yet.";
      } catch (err) {
        $("auditList").textContent = "Unable to load audit log.";
      }
    }

    function drawPseudoQR(text) {
      const canvas = $("qrCanvas");
      const ctx = canvas.getContext("2d");
      const size = 29;
      const cell = canvas.width / size;
      const bytes = new TextEncoder().encode(text);
      let seed = 0;
      for (const b of bytes) seed = ((seed * 131) + b) >>> 0;

      function randBit(x, y) {
        let n = (seed ^ (x * 374761393) ^ (y * 668265263)) >>> 0;
        n = Math.imul(n ^ (n >>> 13), 1274126177);
        return ((n ^ (n >>> 16)) & 1) === 1;
      }
      function finder(x0, y0) {
        ctx.fillStyle = "#000";
        ctx.fillRect(x0 * cell, y0 * cell, 7 * cell, 7 * cell);
        ctx.fillStyle = "#fff";
        ctx.fillRect((x0 + 1) * cell, (y0 + 1) * cell, 5 * cell, 5 * cell);
        ctx.fillStyle = "#000";
        ctx.fillRect((x0 + 2) * cell, (y0 + 2) * cell, 3 * cell, 3 * cell);
      }

      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#000";
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const inFinder =
            (x < 8 && y < 8) ||
            (x >= size - 8 && y < 8) ||
            (x < 8 && y >= size - 8);
          if (!inFinder && randBit(x, y)) {
            ctx.fillRect(x * cell, y * cell, Math.ceil(cell), Math.ceil(cell));
          }
        }
      }
      finder(1, 1);
      finder(size - 8, 1);
      finder(1, size - 8);
    }

    function openPropertyCard(card) {
      const p = card.parcel;
      const f = card.floor;
      $("cardMetrics").innerHTML = `
        <div class="metric"><div class="metric-label">Vertical ULPIN</div><div class="metric-value">${escapeHtml(f.ulpin)}</div></div>
        <div class="metric"><div class="metric-label">Machine ID</div><div class="metric-value">${escapeHtml(f.machine_ulpin)}</div></div>
        <div class="metric"><div class="metric-label">Parcel / Survey</div><div class="metric-value">${escapeHtml(p.id)} · ${escapeHtml(p.survey_no)}</div></div>
        <div class="metric"><div class="metric-label">Owner</div><div class="metric-value">${escapeHtml(f.owner_id)}</div></div>
        <div class="metric"><div class="metric-label">Property Use</div><div class="metric-value">${escapeHtml(f.usage)}</div></div>
        <div class="metric"><div class="metric-label">Area</div><div class="metric-value">${f.area_sqft.toLocaleString()} ft² / ${f.area_sqm.toLocaleString()} m²</div></div>
      `;
      $("cardFloorBreakdown").innerHTML = p.floors.map(ff => `
        <div class="floor-item !cursor-default">
          <div><div class="floor-name">${escapeHtml(ff.name)}</div><div class="floor-usage">${escapeHtml(ff.usage)} · ${ff.area_sqft.toLocaleString()} ft²</div></div>
          <div class="floor-code">${escapeHtml(ff.ulpin)}</div>
        </div>
      `).join("");
      $("cardIssuedAt").textContent = new Date(card.issued_at).toLocaleString();
      $("cardId").textContent = card.card_id;
      drawPseudoQR(`${card.card_id}|${f.machine_ulpin}|${p.id}`);
      $("propertyModal").classList.add("show");
    }

    function closePropertyCard() {
      $("propertyModal")?.classList.remove("show");
    }

    // -------------------------------------------------------------------------
    // Background canvas engine: checkered grid with mouse-proximity glow + lerp
    // -------------------------------------------------------------------------
    const bg = {
      canvas: $("bgCanvas"),
      ctx: $("bgCanvas").getContext("2d"),
      dpr: Math.min(window.devicePixelRatio || 1, 1.25),
      mouse: { x: -1000, y: -1000 },
      cells: [],
      cellSize: 42,
      cols: 0,
      rows: 0
    };
    let bgFrame = null;

    function resizeBackground() {
      bg.dpr = Math.min(window.devicePixelRatio || 1, 1.25);
      bg.canvas.width = Math.floor(innerWidth * bg.dpr);
      bg.canvas.height = Math.floor(innerHeight * bg.dpr);
      bg.canvas.style.width = `${innerWidth}px`;
      bg.canvas.style.height = `${innerHeight}px`;
      bg.ctx.setTransform(bg.dpr, 0, 0, bg.dpr, 0, 0);
      bg.cols = Math.ceil(innerWidth / bg.cellSize);
      bg.rows = Math.ceil(innerHeight / bg.cellSize);
      bg.cells = new Array(bg.cols * bg.rows).fill(0).map(() => ({ glow: 0 }));
    }

    function animateBackground() {
      bgFrame = null;
      if (document.hidden || !isSceneMotionActive()) return;
      const ctx = bg.ctx;
      const cs = bg.cellSize;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      const isLight = document.body.classList.contains("light-theme");
      ctx.lineWidth = 1;

      for (let row = 0; row < bg.rows; row++) {
        for (let col = 0; col < bg.cols; col++) {
          const i = row * bg.cols + col;
          const cell = bg.cells[i];
          const x = col * cs;
          const y = row * cs;
          const cx = x + cs / 2;
          const cy = y + cs / 2;
          const dist = Math.hypot(cx - bg.mouse.x, cy - bg.mouse.y);
          const target = Math.max(0, 1 - dist / 170);
          cell.glow += (target - cell.glow) * 0.09;

          const baseAlpha = isLight ? 0.045 : 0.035;
          const checkerBoost = ((row + col) % 2 === 0) ? 0.012 : 0;
          ctx.fillStyle = isLight
            ? `rgba(0, 92, 118, ${baseAlpha + checkerBoost + cell.glow * 0.09})`
            : `rgba(90, 220, 245, ${baseAlpha + checkerBoost + cell.glow * 0.11})`;
          ctx.fillRect(x, y, cs - 1, cs - 1);

          if (cell.glow > 0.02) {
            ctx.strokeStyle = isLight
              ? `rgba(0, 135, 170, ${cell.glow * 0.28})`
              : `rgba(130, 245, 255, ${cell.glow * 0.38})`;
            ctx.strokeRect(x + 0.5, y + 0.5, cs - 1.5, cs - 1.5);
          }
        }
      }
      requestBackgroundFrame();
    }

    function requestBackgroundFrame() {
      if (bgFrame !== null) return;
      bgFrame = requestAnimationFrame(animateBackground);
    }

    window.addEventListener("mousemove", e => {
      bg.mouse.x = e.clientX;
      bg.mouse.y = e.clientY;
      if (isSceneMotionActive()) requestBackgroundFrame();
    }, { passive: true });

    window.addEventListener("mouseleave", () => {
      bg.mouse.x = -1000;
      bg.mouse.y = -1000;
    });

    function isHyderabadUrban(parcel = state.selectedParcel) {
      return parcel?.area_id === "HYD" && parcel?.district === "Hyderabad";
    }

    function hashUnit(seed) {
      let h = 2166136261;
      for (let i = 0; i < seed.length; i++) {
        h ^= seed.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return (h >>> 0) / 4294967295;
    }

    function selectedBuilding(parcel, floor) {
      return parcel?.buildings?.find(b => b.floors.some(item => item.id === floor?.id)) || parcel?.buildings?.[0] || null;
    }

    function generateHyderabadBlueprint(parcel, floor) {
      const building = selectedBuilding(parcel, floor);
      if (!parcel || !floor || !building || !isHyderabadUrban(parcel)) return null;
      const seed = `${parcel.id}|${building.id}|${floor.id}|blueprint-v1`;
      const width = Math.max(860, Math.round((building.w || 7) * 118));
      const height = Math.max(580, Math.round((building.d || 6) * 112));
      const balconySide = hashUnit(seed + ":balcony") > .42 ? "right" : "top";
      const serviceCore = hashUnit(seed + ":core") > .5 ? "left" : "right";
      const inner = {x: 0, y: 0, w: width, h: height};
      const rooms = [];
      const add = (id, name, x, y, w, h, type, areaRatio = 1) => rooms.push({id, name, x, y, w, h, type, area_sqft: Math.round(floor.area_sqft * areaRatio)});
      if (floor.usage === "Residential" || parcel.land_use === "Residential") {
        add("living", "Living Room", width * .43, height * .42, width * .39, height * .38, "room", .28);
        add("bed1", "Bedroom 1", width * .06, height * .08, width * .31, height * .27, "room", .20);
        add("bed2", "Bedroom 2", width * .06, height * .57, width * .31, height * .29, "room", .20);
        add("kitchen", "Kitchen", width * .51, height * .08, width * .31, height * .25, "room", .14);
        add("toilet1", "Toilet 1", width * .38, height * .08, width * .12, height * .25, "service", .05);
        add("toilet2", "Toilet 2", width * .38, height * .57, width * .12, height * .29, "service", .05);
        add("corridor", "Corridor", width * .31, height * .36, width * .36, height * .18, "corridor", .08);
      } else if (/Industrial|Dispatch|Storage|Utilities/.test(floor.usage)) {
        add("bay", `${floor.usage} Bay`, width * .06, height * .10, width * .55, height * .72, "room", .58);
        add("office", "Operations Office", width * .64, height * .10, width * .23, height * .26, "room", .15);
        add("service", "Service Core", width * .64, height * .42, width * .23, height * .18, "service", .08);
        add("stair", "Stairs", width * .64, height * .65, width * .23, height * .17, "stair", .07);
      } else {
        add("open", `${floor.usage} Hall`, width * .07, height * .10, width * .52, height * .46, "room", .45);
        add("work", "Work Area", width * .07, height * .60, width * .52, height * .25, "room", .22);
        add("meeting", "Meeting Room", width * .63, height * .10, width * .23, height * .24, "room", .12);
        add("service", "Service Core", width * .63, height * .39, width * .23, height * .18, "service", .07);
        add("stair", "Stairs", width * .63, height * .62, width * .23, height * .23, "stair", .08);
      }
      const balcony = balconySide === "right"
        ? {x: width * .82, y: height * .20, w: width * .14, h: height * .46}
        : {x: width * .34, y: height * .02, w: width * .32, h: height * .10};
      if (!/Industrial|Dispatch|Storage|Utilities|Terrace/.test(floor.usage)) add("balcony", "Balcony", balcony.x, balcony.y, balcony.w, balcony.h, "balcony", .06);
      add("entry", serviceCore === "left" ? "Entry Lobby" : "Entry", width * .43, height * .82, width * .16, height * .08, "entry", .03);
      return {parcel, building, floor, width, height, rooms, boundary: inner, seed};
    }

    function blueprintCanvasSize() {
      const canvas = $("blueprintCanvas");
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(rect.width * ratio));
      const h = Math.max(1, Math.round(rect.height * ratio));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w; canvas.height = h;
      }
      return {canvas, ctx: canvas.getContext("2d"), rect, ratio};
    }

    function blueprintToScreen(x, y, size = blueprintCanvasSize()) {
      const bp = state.blueprint;
      return {x: x * bp.scale + bp.panX, y: y * bp.scale + bp.panY, size};
    }

    function screenToBlueprint(x, y) {
      const bp = state.blueprint;
      return {x: (x - bp.panX) / bp.scale, y: (y - bp.panY) / bp.scale};
    }

    function resetBlueprintView() {
      const plan = state.blueprint.plan;
      const size = blueprintCanvasSize();
      if (!plan || !size) return;
      const reservedRight = size.rect.width > 780 ? 280 : 24;
      const scale = Math.min((size.rect.width - reservedRight - 90) / plan.width, (size.rect.height - 150) / plan.height);
      state.blueprint.scale = Math.max(.35, scale);
      state.blueprint.panX = 44;
      state.blueprint.panY = Math.max(78, (size.rect.height - plan.height * state.blueprint.scale) / 2 + 20);
      drawBlueprint();
    }

    function drawBlueprint() {
      const plan = state.blueprint.plan;
      const size = blueprintCanvasSize();
      if (!plan || !size) return;
      const {ctx, canvas, ratio} = size;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, canvas.width / ratio, canvas.height / ratio);
      ctx.lineCap = "square";
      for (let x = state.blueprint.panX % (32 * state.blueprint.scale); x < canvas.width / ratio; x += 32 * state.blueprint.scale) {
        ctx.strokeStyle = "rgba(94,231,255,.035)"; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height / ratio); ctx.stroke();
      }
      for (let y = state.blueprint.panY % (32 * state.blueprint.scale); y < canvas.height / ratio; y += 32 * state.blueprint.scale) {
        ctx.strokeStyle = "rgba(94,231,255,.035)"; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width / ratio, y); ctx.stroke();
      }
      const bp = state.blueprint;
      const sx = x => x * bp.scale + bp.panX;
      const sy = y => y * bp.scale + bp.panY;
      ctx.save();
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(180,236,255,.92)";
      ctx.strokeRect(sx(0), sy(0), plan.width * bp.scale, plan.height * bp.scale);
      plan.rooms.forEach(room => {
        const active = room === bp.hoverRoom || room === bp.selectedRoom;
        ctx.fillStyle = active ? "rgba(94,231,255,.15)" : room.type === "balcony" ? "rgba(94,231,255,.045)" : "rgba(8,31,43,.38)";
        ctx.strokeStyle = active ? "rgba(124,248,207,.96)" : room.type === "service" ? "rgba(154,211,232,.78)" : "rgba(139,218,246,.82)";
        ctx.lineWidth = room.type === "corridor" ? 1.4 : 2;
        ctx.fillRect(sx(room.x), sy(room.y), room.w * bp.scale, room.h * bp.scale);
        ctx.strokeRect(sx(room.x), sy(room.y), room.w * bp.scale, room.h * bp.scale);
        if (room.w * bp.scale > 70 && room.h * bp.scale > 36) {
          ctx.fillStyle = active ? "#dffcff" : "rgba(218,243,255,.82)";
          ctx.font = "11px system-ui, sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(room.name, sx(room.x + room.w / 2), sy(room.y + room.h / 2));
        }
      });
      ctx.strokeStyle = "rgba(180,236,255,.82)";
      ctx.lineWidth = 1.2;
      plan.rooms.filter(r => r.type !== "balcony").slice(0, 7).forEach((room, i) => {
        const doorX = sx(room.x + room.w * (.15 + (i % 3) * .23));
        const doorY = sy(room.y + room.h);
        ctx.beginPath(); ctx.arc(doorX, doorY, 24 * bp.scale, Math.PI, Math.PI * 1.5); ctx.stroke();
      });
      ctx.strokeStyle = "rgba(124,248,207,.86)";
      ctx.lineWidth = 3;
      for (let i = 1; i < 5; i++) {
        const x = sx(plan.width * i / 5);
        ctx.beginPath(); ctx.moveTo(x, sy(-2)); ctx.lineTo(x + 48 * bp.scale, sy(-2)); ctx.stroke();
      }
      ctx.fillStyle = "rgba(218,243,255,.72)";
      ctx.font = "10px ui-monospace, monospace";
      ctx.textAlign = "left";
      ctx.fillText(`${Math.round(plan.width / 34)} m`, sx(0), sy(plan.height + 28));
      ctx.fillText(`${Math.round(plan.height / 34)} m`, sx(plan.width + 16), sy(plan.height / 2));
      ctx.restore();
    }

    function updateBlueprintPanel(room = state.blueprint.selectedRoom) {
      const plan = state.blueprint.plan;
      if (!plan) return;
      $("blueprintFloorLabel").textContent = plan.floor.name;
      $("blueprintUsageLabel").textContent = plan.floor.usage;
      const facts = [
        ["Parcel", plan.parcel.id],
        ["Building", plan.building.id],
        ["Area", `${plan.floor.area_sqft.toLocaleString()} sq ft`],
        ["Rooms", String(plan.rooms.filter(r => !["corridor", "entry"].includes(r.type)).length)],
        ["ULPIN", plan.floor.ulpin]
      ];
      const bedrooms = plan.rooms.filter(r => /Bedroom/.test(r.name)).length;
      const bathrooms = plan.rooms.filter(r => /Toilet|Bath/.test(r.name)).length;
      const balconies = plan.rooms.filter(r => r.type === "balcony").length;
      if (bedrooms) facts.splice(4, 0, ["Bedrooms", String(bedrooms)]);
      if (bathrooms) facts.splice(5, 0, ["Bathrooms", String(bathrooms)]);
      if (balconies) facts.splice(6, 0, ["Balcony", String(balconies)]);
      $("blueprintFacts").innerHTML = facts.map(([k, v]) => `<div><span>${escapeHtml(k)}</span><b>${escapeHtml(v)}</b></div>`).join("");
      $("blueprintRoomPanel").innerHTML = room
        ? `<strong>${escapeHtml(room.name)}</strong><br>${escapeHtml(room.type)}${room.area_sqft ? ` - approx. ${room.area_sqft.toLocaleString()} sq ft` : ""}`
        : "Select a room";
    }

    function roomAtBlueprintPoint(point) {
      const rooms = state.blueprint.plan?.rooms || [];
      for (let i = rooms.length - 1; i >= 0; i--) {
        const r = rooms[i];
        if (point.x >= r.x && point.x <= r.x + r.w && point.y >= r.y && point.y <= r.y + r.h) return r;
      }
      return null;
    }

    function openBlueprintForSelection() {
      const parcel = state.selectedParcel, floor = state.selectedFloor;
      const plan = generateHyderabadBlueprint(parcel, floor);
      if (!plan) { toast("Blueprint is currently available only for Hyderabad Urban building floors.", "info"); return; }
      hideFloorContextMenu();
      isolateFloor(parcel.id, floor.id);
      focusFloor(parcel.id, floor.id);
      $("blueprintTransitionTitle").textContent = `Generating ${floor.name} blueprint`;
      $("blueprintTransitionMeta").textContent = `${parcel.id} / ${floor.ulpin}`;
      $("blueprintTransition").classList.add("show");
      setTimeout(() => {
        state.blueprint = {...state.blueprint, open: true, plan, hoverRoom: null, selectedRoom: null, dragging: false, moved: false};
        document.body.classList.add("blueprint-open");
        $("blueprintView").classList.add("show");
        $("blueprintView").setAttribute("aria-hidden", "false");
        $("blueprintTransition").classList.remove("show");
        $("blueprintCrumb").textContent = `HYDERABAD URBAN / ${parcel.id} / ${floor.name} / BLUEPRINT`;
        $("blueprintTitle").textContent = `${floor.name} Blueprint`;
        updateBlueprintPanel(null);
        resetBlueprintView();
        lucide.createIcons();
      }, reducedMotion.matches ? 80 : 650);
    }

    function closeBlueprintView() {
      state.blueprint.open = false;
      state.blueprint.plan = null;
      document.body.classList.remove("blueprint-open");
      $("blueprintView")?.classList.remove("show");
      $("blueprintView")?.setAttribute("aria-hidden", "true");
      hideFloorContextMenu();
      if (state.sceneReady) { set3DView(false); renderStillFrame(); }
    }

    function hideFloorContextMenu() {
      $("floorContextMenu")?.classList.remove("show");
      $("floorContextMenu")?.setAttribute("aria-hidden", "true");
    }

    function positionFloorContextMenu(event) {
      const menu = $("floorContextMenu");
      const viewport = $("viewport");
      if (!menu || !viewport) return;
      menu.classList.add("show");
      const menuRect = menu.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      const containingBlock = menu.offsetParent || menu.parentElement;
      const containingRect = containingBlock.getBoundingClientRect();
      const gap = 8;
      const x = event.clientX + menuRect.width + gap <= viewportRect.right
        ? event.clientX + gap
        : event.clientX - menuRect.width - gap;
      const y = event.clientY + menuRect.height + gap <= viewportRect.bottom
        ? event.clientY + gap
        : event.clientY - menuRect.height - gap;
      menu.style.right = "auto";
      menu.style.bottom = "auto";
      const finalX = clamp(x, viewportRect.left + gap, viewportRect.right - menuRect.width - gap);
      const finalY = clamp(y, viewportRect.top + gap, viewportRect.bottom - menuRect.height - gap);
      menu.style.left = `${finalX - containingRect.left}px`;
      menu.style.top = `${finalY - containingRect.top}px`;
    }

    function showFloorContextMenu(event, mesh) {
      const parcel = state.parcelById.get(mesh?.userData?.parcelId);
      const floor = parcel?.floors.find(f => f.id === mesh?.userData?.floorId);
      if (!parcel || !floor || !isHyderabadUrban(parcel) || !mesh.userData.buildingId) return;
      event.preventDefault();
      selectFloor(parcel.id, floor.id, false, false);
      const menu = $("floorContextMenu");
      positionFloorContextMenu(event);
      menu.setAttribute("aria-hidden", "false");
      lucide.createIcons({nodes: [menu]});
    }

    function showSelectedFloorContextMenu(event) {
      const parcel = state.selectedParcel;
      const floor = state.selectedFloor;
      const building = selectedBuilding(parcel, floor);
      if (!parcel || !floor || !building || !isHyderabadUrban(parcel)) return false;
      event.preventDefault();
      const menu = $("floorContextMenu");
      positionFloorContextMenu(event);
      menu.setAttribute("aria-hidden", "false");
      lucide.createIcons({nodes: [menu]});
      return true;
    }

    // -------------------------------------------------------------------------
    // Three.js spatial engine
    // -------------------------------------------------------------------------
    let scene, renderer, perspectiveCamera, orthoCamera, activeCamera, controls;
    let terrainGroup, parcelGroup, buildingGroup, riskGroup, conflictGroup, pipelineGroup, undergroundGroup;
    let undergroundAssets = [], hoveredInfrastructure = null;
    let floorMeshes = [];
    let raycaster, pointer;
    let hoveredFloor = null;
    let hoveredParcel = null;
    let hoveredConflict = null;
    let cameraTween = null;
    let conflictPulse = null;
    let lastFrameTime = performance.now();
    let fpsFrames = 0;
    let fpsAccum = 0;
    let resize3DFrame = null;
    let sceneFrame = null;
    let sceneBounds, sweep, selectionFrame;
    let isolation = null;
    let assemblyStart = -100;
    let pointerDown = null;
    let viewportVisible = true;
    const buildingDecor = [];
    const parcelTracers = [];
    const surveyFrames = [];
    const parcelPickMeshes = [];
    const buildingPickMeshes = [];
    const fieldPickMeshes = [];
    const selectionPosition = { parcelId: null };
    const boundaryPaths = new WeakMap();
    let sceneScratch, selectionScale;
    let panelGeometry, beaconGeometry, orchardGeometry, podiumMaterial;
    let pendingPointer = null;
    let rebuildingScene = false;
    const sceneVisuals = window.ULPINSceneVisuals;

    function disposeGroup(group) {
      if (!group) return;
      const geometries = new Set(), materials = new Set(), textures = new Set();
      group.traverse(obj => {
        if (obj.geometry) geometries.add(obj.geometry);
        const list = Array.isArray(obj.material) ? obj.material : [obj.material];
        list.filter(Boolean).forEach(material => {
          materials.add(material);
          Object.values(material).forEach(value => { if (value?.isTexture) textures.add(value); });
        });
        if (obj.isInstancedMesh) obj.dispose?.();
      });
      textures.forEach(texture => texture.dispose());
      materials.forEach(material => material.dispose());
      geometries.forEach(geometry => geometry.dispose());
      group.clear();
    }

    function updateSceneBounds() {
      sceneBounds = new THREE.Box3();
      state.sceneParcels.forEach(p => {
        sceneBounds.expandByPoint(new THREE.Vector3(p.position.x - p.size.w / 2, 0, p.position.z - p.size.d / 2));
        sceneBounds.expandByPoint(new THREE.Vector3(p.position.x + p.size.w / 2, buildingHeight(p) + 2, p.position.z + p.size.d / 2));
        p.buildings.forEach(b => b.footprint.forEach(v => {
          sceneBounds.expandByPoint(new THREE.Vector3(b.position.x + v.x, b.position.y, b.position.z + v.z));
          sceneBounds.expandByPoint(new THREE.Vector3(b.position.x + v.x, b.position.y + b.height + 2, b.position.z + v.z));
        }));
      });
      const area = land.areas.find(a => a.id === state.activeAreaId);
      area?.spatial?.roads.forEach(road => road.points.forEach(p => sceneBounds.expandByPoint(new THREE.Vector3(p.x, 0, p.z))));
      if (sceneBounds.isEmpty()) sceneBounds.set(new THREE.Vector3(-10, 0, -10), new THREE.Vector3(10, 1, 10));
    }

    function replaceLocationScene() {
      rebuildingScene = true;
      pendingPointer = null;
      clearHover();
      cameraTween = null;
      pointerDown = null;
      isolation = null;
      motion.exploded = false;
      assemblyStart = -100;
      selectionPosition.parcelId = null;
      disposeGroup(riskGroup);
      disposeGroup(conflictGroup);
      disposeGroup(pipelineGroup); disposeGroup(undergroundGroup);
      conflictPulse = null;
      updateSceneBounds();
      buildTerrain();
      buildParcelScene();
      buildUndergroundScene();
      buildSurveyEffects();
      renderer.renderLists.dispose();
      updateSceneTheme();
      onResize3D();
      const damping = controls.enableDamping;
      controls.enableDamping = false;
      controls.update();
      controls.enableDamping = damping;
      resetCamera(true);
      renderPreflightOverlapVolumes();
      rebuildingScene = false;
      renderStillFrame();
    }

    function parcelOutline(parcel) {
      return parcel.boundary || [
        {x: parcel.position.x - parcel.size.w / 2, z: parcel.position.z - parcel.size.d / 2},
        {x: parcel.position.x + parcel.size.w / 2, z: parcel.position.z - parcel.size.d / 2},
        {x: parcel.position.x + parcel.size.w / 2, z: parcel.position.z + parcel.size.d / 2},
        {x: parcel.position.x - parcel.size.w / 2, z: parcel.position.z + parcel.size.d / 2}
      ];
    }

    function polygonGeometry(points, height = 0) {
      const shape = new THREE.Shape(points.map(p => new THREE.Vector2(p.x, -p.z)));
      const geometry = height ? new THREE.ExtrudeGeometry(shape, {depth: height, bevelEnabled: false}) : new THREE.ShapeGeometry(shape);
      geometry.rotateX(-Math.PI / 2);
      if (height) geometry.translate(0, -height / 2, 0);
      return geometry;
    }

    function isSceneMotionActive() {
      return motion.enabled && motion.viewportActive && !reducedMotion.matches;
    }

    function renderStillFrame() {
      if (rebuildingScene || !renderer || !scene || !activeCamera) return;
      animateSpatialLayers(1 / 60);
      if (controls) {
        controls.autoRotate = false;
        controls.update();
      }
      renderer.render(scene, activeCamera);
    }

    function requestSceneFrame() {
      if (sceneFrame !== null) return;
      sceneFrame = requestAnimationFrame(animate3D);
    }

    function setViewportActive(active) {
      const next = Boolean(active) && !reducedMotion.matches;
      if (motion.viewportActive === next) return;
      motion.viewportActive = next;
      lastFrameTime = performance.now();
      fpsFrames = 0;
      fpsAccum = 0;
      $("fpsCounter").textContent = next ? "FPS --" : "IDLE";
      if (!next) {
        if (controls) controls.autoRotate = false;
        clearHover();
        renderStillFrame();
      } else {
        requestBackgroundFrame();
        requestSceneFrame();
      }
      syncMotionControls();
    }

    function init3D() {
      const container = $("viewport");
      const scenePanel = document.querySelector(".right-panel");
      scene = new THREE.Scene();
      scene.fog = new THREE.FogExp2(0x0b0e11, 0.0006);
      raycaster = new THREE.Raycaster();
      raycaster.params.Line.threshold = 0.5;
      pointer = new THREE.Vector2();
      sceneScratch = new THREE.Vector3();
      selectionScale = new THREE.Vector3();
      updateSceneBounds();

      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
      renderer.setSize(container.clientWidth, container.clientHeight, false);
      renderer.outputEncoding = THREE.sRGBEncoding;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1;
      renderer.shadowMap.enabled = false;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      container.appendChild(renderer.domElement);

      perspectiveCamera = new THREE.PerspectiveCamera(48, container.clientWidth / container.clientHeight, 0.1, 3000);
      perspectiveCamera.position.set(28, 24, 32);

      const aspect = container.clientWidth / container.clientHeight;
      const frustum = Math.max(sceneBounds.getSize(new THREE.Vector3()).z + 20, sceneBounds.getSize(new THREE.Vector3()).x / aspect + 20);
      orthoCamera = new THREE.OrthographicCamera(
        -frustum * aspect / 2, frustum * aspect / 2,
        frustum / 2, -frustum / 2,
        0.1, 3000
      );
      orthoCamera.position.set(0, 52, 0.01);
      orthoCamera.up.set(0, 0, -1);

      activeCamera = perspectiveCamera;
      controls = new THREE.OrbitControls(activeCamera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.065;
      controls.minDistance = 8;
      controls.maxDistance = 1800;
      controls.maxPolarAngle = Math.PI * 0.49;
      controls.target.set(0, 4, 2);
      bindOrbitInteraction();

      const hemi = new THREE.HemisphereLight(0xc4e0ef, 0x464d3d, .8);
      scene.add(hemi);

      const sun = new THREE.DirectionalLight(0xffe2ba, 1.2);
      sun.position.set(-25, 40, 20);
      sun.castShadow = true;
      sun.shadow.mapSize.set(512, 512);
      sun.shadow.camera.left = -40;
      sun.shadow.camera.right = 40;
      sun.shadow.camera.top = 40;
      sun.shadow.camera.bottom = -40;
      scene.add(sun);

      const cyanLight = new THREE.PointLight(0x5ee7ff, 0.18, 65);
      cyanLight.position.set(-15, 15, -8);
      scene.add(cyanLight);
      const rimLight = new THREE.DirectionalLight(0x95c7df, .4);
      rimLight.position.set(-20, 12, -22);
      scene.add(rimLight);

      terrainGroup = new THREE.Group();
      terrainGroup.name = "terrain";
      parcelGroup = new THREE.Group();
      parcelGroup.name = "parcels";
      buildingGroup = new THREE.Group();
      buildingGroup.name = "buildings";
      riskGroup = new THREE.Group();
      riskGroup.name = "overlap-risk";
      conflictGroup = new THREE.Group();
      conflictGroup.name = "conflict";
      pipelineGroup = new THREE.Group(); pipelineGroup.name = "pipelines";
      undergroundGroup = new THREE.Group(); undergroundGroup.name = "underground";
      scene.add(terrainGroup, parcelGroup, buildingGroup, riskGroup, conflictGroup, pipelineGroup, undergroundGroup);

      buildTerrain();
      buildParcelScene();
      buildUndergroundScene();
      buildSurveyEffects();

      scenePanel?.addEventListener("pointerenter", () => setViewportActive(true), { passive: true });
      scenePanel?.addEventListener("pointerleave", () => setViewportActive(false), { passive: true });
      scenePanel?.addEventListener("focusin", () => setViewportActive(true));
      scenePanel?.addEventListener("focusout", event => {
        if (!scenePanel.contains(event.relatedTarget)) setViewportActive(false);
      });
      renderer.domElement.addEventListener("pointermove", event => {
        pendingPointer = {clientX: event.clientX, clientY: event.clientY};
        requestSceneFrame();
      }, { passive: true });
      renderer.domElement.addEventListener("pointerleave", clearHover, { passive: true });
      renderer.domElement.addEventListener("pointerdown", event => {
        setViewportActive(true);
        pointerDown = { x: event.clientX, y: event.clientY };
      });
      renderer.domElement.addEventListener("pointerup", event => {
        if (pointerDown && Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) < 5) {
          pendingPointer = null;
          onPointerMove(event);
          onViewportClick();
        }
        pointerDown = null;
      });
      renderer.domElement.addEventListener("pointercancel", () => { pointerDown = null; });
      renderer.domElement.addEventListener("contextmenu", event => {
        pendingPointer = null;
        onPointerMove(event);
        if (hoveredFloor) showFloorContextMenu(event, hoveredFloor);
        else if (!showSelectedFloorContextMenu(event)) hideFloorContextMenu();
      });
      new ResizeObserver(() => {
        if (splitLayout.dragging || document.querySelector(".workspace")?.classList.contains("layout-animating")) return;
        scheduleResize3D();
      }).observe(container);
      new IntersectionObserver(entries => {
        viewportVisible = entries[0].isIntersecting;
        if (viewportVisible) requestSceneFrame();
      }).observe(container);
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) { lastFrameTime = performance.now(); requestSceneFrame(); }
      });

      state.sceneReady = true;
      updateSceneTheme();
      onResize3D();
      resetCamera(true);
      syncMotionControls();
      renderPreflightOverlapVolumes();
      updateSelectionChip();
      renderStillFrame();
    }

    function statusColor(parcel) {
      return parcel.status.includes("Disputed") ? 0xff6577 : /Pending|Review|Unverified/.test(parcel.status) ? 0xffc857 : 0x7cf8cf;
    }

    function boundaryPoint(parcel, progress, y = 0.12, target = new THREE.Vector3()) {
      let path = boundaryPaths.get(parcel);
      if (!path) {
        const points = parcelOutline(parcel);
        const lengths = points.map((p, i) => Math.hypot(p.x - points[(i + 1) % points.length].x, p.z - points[(i + 1) % points.length].z));
        path = {points, lengths, length: lengths.reduce((sum, n) => sum + n, 0)};
        boundaryPaths.set(parcel, path);
      }
      const {points, lengths} = path;
      let distance = ((progress % 1) + 1) % 1 * path.length;
      for (let i = 0; i < points.length; i++) {
        if (distance <= lengths[i] || i === points.length - 1) {
          const a = points[i], b = points[(i + 1) % points.length], t = distance / lengths[i];
          return target.set(a.x + (b.x - a.x) * t, y, a.z + (b.z - a.z) * t);
        }
        distance -= lengths[i];
      }
    }

    function buildSurveyEffects() {
      const size = sceneBounds.getSize(new THREE.Vector3());
      const center = sceneBounds.getCenter(new THREE.Vector3());
      sweep = new THREE.Group();
      const strip = new THREE.Mesh(new THREE.PlaneGeometry(size.x + 8, 1.8), new THREE.MeshBasicMaterial({ color: 0x7cf8cf, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide }));
      strip.rotation.x = -Math.PI / 2;
      sweep.add(strip);
      const lead = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-size.x / 2 - 4, 0, -.9), new THREE.Vector3(size.x / 2 + 4, 0, -.9)]), new THREE.LineBasicMaterial({ color: 0x7cf8cf, transparent: true, opacity: .65 }));
      sweep.add(lead);
      sweep.position.set(center.x, .09, center.z);
      terrainGroup.add(sweep);
      const corners = [];
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        corners.push(new THREE.Vector3(sx * .34, 0, sz * .5), new THREE.Vector3(sx * .5, 0, sz * .5));
        corners.push(new THREE.Vector3(sx * .5, 0, sz * .5), new THREE.Vector3(sx * .5, 0, sz * .34));
        corners.push(new THREE.Vector3(sx * .5, 0, sz * .5), new THREE.Vector3(sx * .5, 1.2, sz * .5));
      }
      selectionFrame = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(corners), new THREE.LineBasicMaterial({ color: 0xf5fcff, transparent: true, opacity: .8 }));
      parcelGroup.add(selectionFrame);
    }

    function buildTerrain() {
      disposeGroup(terrainGroup);

      const groundSize = sceneBounds.getSize(new THREE.Vector3());
      const groundCenter = sceneBounds.getCenter(new THREE.Vector3());
      const span = Math.ceil(Math.max(groundSize.x, groundSize.z) / 2) * 2 + 10;
      const groundGeo = new THREE.PlaneGeometry(span, span, 1, 1);
      const groundMat = new THREE.MeshStandardMaterial({
        color: sceneVisuals.palette.ground,
        roughness: 0.92,
        metalness: 0.04,
        transparent: false,
        opacity: 1,
        depthWrite: true
      });
      const ground = new THREE.Mesh(groundGeo, groundMat);
      ground.rotation.x = -Math.PI / 2;
      ground.position.set(groundCenter.x, -0.12, groundCenter.z);
      ground.receiveShadow = true;
      ground.userData.kind = "ground";
      terrainGroup.add(ground);

      const roads = land.areas.find(a => a.id === state.activeAreaId)?.spatial?.roads || [];
      roads.forEach(road => {
        const positions = [];
        for (let i = 1; i < road.points.length; i++) {
          const a = road.points[i - 1], b = road.points[i];
          const length = Math.hypot(b.x - a.x, b.z - a.z);
          if (!length) continue;
          const dx = -(b.z - a.z) / length * road.width / 2, dz = (b.x - a.x) / length * road.width / 2;
          const corners = [[a.x + dx, a.z + dz], [b.x + dx, b.z + dz], [b.x - dx, b.z - dz], [a.x - dx, a.z - dz]];
          [0, 1, 2, 0, 2, 3].forEach(n => positions.push(corners[n][0], -.04, corners[n][1]));
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
        const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({color: road.kind === "canal" ? 0x398ca4 : road.kind === "track" ? 0x77796e : sceneVisuals.palette.asphalt, side: THREE.DoubleSide}));
        mesh.material.color.convertSRGBToLinear();
        mesh.userData = {kind: road.kind, areaId: state.activeAreaId};
        terrainGroup.add(mesh);
      });
      sceneVisuals.streets(terrainGroup, roads);
      sceneVisuals.landscape(terrainGroup, state.sceneParcels);
      if (state.sceneParcels.length) sceneVisuals.surroundingLandscape(terrainGroup, sceneBounds, state.activeAreaId, state.sceneParcels);
    }

    function makeParcelBoundary(parcel) {
      const { x, z } = parcel.position;
      const w = parcel.size.w;
      const d = parcel.size.d;
      const y = 0.015;
      const outline = parcelOutline(parcel);
      const points = [...outline, outline[0]].map(p => new THREE.Vector3(p.x, y, p.z));
      const geo = new THREE.BufferGeometry().setFromPoints(points);
      const parcelColor = colorForParcel(parcel);
      const mat = new THREE.LineBasicMaterial({ color: parcelColor, transparent: true, opacity: 0.86 });
      const line = new THREE.Line(geo, mat);
      line.userData = { kind: "parcel-boundary", parcelId: parcel.id };
      parcelGroup.add(line);

      const fillGeo = polygonGeometry(outline);
      const fillMat = new THREE.MeshBasicMaterial({
        color: parcelColor,
        transparent: true,
        opacity: 0.065,
        side: THREE.DoubleSide,
        depthWrite: false
      });
      const fill = new THREE.Mesh(fillGeo, fillMat);
      fill.position.y = -0.01;
      fill.userData = { kind: "parcel-fill", parcelId: parcel.id };
      parcelGroup.add(fill);
      const trailGeo = new THREE.BufferGeometry().setFromPoints(Array.from({ length: 18 }, (_, i) => boundaryPoint(parcel, i / 100)));
      const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: statusColor(parcel), transparent: true, opacity: .95 }));
      trail.userData = { kind: "parcel-tracer", parcelId: parcel.id };
      trail.frustumCulled = false;
      parcelGroup.add(trail);
      parcelTracers.push({ trail, parcel, fill, line, phase: parcelTracers.length * .083, color: null, boundaryColor: null });
      parcelPickMeshes.push(fill);
    }

    function buildBuilding(parcel, parcelIndex) {
      if (parcel.agriculture) {
        const outline = parcelOutline(parcel).map(p => ({x: (p.x - parcel.position.x) * .96, z: (p.z - parcel.position.z) * .96}));
        const mesh = new THREE.Mesh(polygonGeometry(outline, .22),
          sceneVisuals.surface({color: sceneVisuals.cropColor(parcel), roughness: 1, emissive: 0x84cc16, emissiveIntensity: 0, transparent: true, opacity: 1}));
        mesh.position.set(parcel.position.x, .15, parcel.position.z);
        mesh.userData = {kind: "land-record", parcelId: parcel.id, floorId: "F0", floorIndex: 0, baseOpacity: 1,
          baseColor: 0x84cc16, baseY: .15, baseScale: 1, phase: parcelIndex * .1, delay: 0, explodeY: 0};
        const pattern = parcel.cultivation_pattern;
        const c = Math.cos(pattern.angle), s = Math.sin(pattern.angle);
        const rotated = outline.map(p => ({x: p.x * c + p.z * s, z: -p.x * s + p.z * c}));
        const rows = [], plants = [];
        const point = (x, z, y = .15) => new THREE.Vector3(x * c - z * s, y, x * s + z * c);
        // Clip cultivation rows to the actual parcel polygon, including chamfered corners.
        for (let z = Math.min(...rotated.map(p => p.z)) + pattern.spacing; z < Math.max(...rotated.map(p => p.z)); z += pattern.spacing) {
          const crossings = [];
          rotated.forEach((a, i) => {
            const b = rotated[(i + 1) % rotated.length];
            if ((a.z <= z && b.z > z) || (b.z <= z && a.z > z)) crossings.push(a.x + (z - a.z) * (b.x - a.x) / (b.z - a.z));
          });
          crossings.sort((a, b) => a - b);
          for (let i = 0; i + 1 < crossings.length; i += 2) {
            const left = crossings[i] + .3, right = crossings[i + 1] - .3;
            if (right <= left) continue;
            rows.push(point(left, z), point(right, z));
            if (pattern.kind === "orchard" && !pattern.fallow) {
              for (let x = left + .5; x < right - .5; x += pattern.spacing) plants.push(point(x, z, .6));
            }
          }
        }
        mesh.add(sceneVisuals.cropBeds(rows, parcel));
        const cropPlants = sceneVisuals.cropPlants(rows, parcel);
        if (cropPlants) mesh.add(cropPlants);
        const furrows = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(rows), new THREE.LineBasicMaterial({color: pattern.fallow ? 0x514e37 : 0x3e5637, transparent: true, opacity: .7}));
        furrows.userData.kind = "crop-furrows";
        mesh.add(furrows);
        if (plants.length) {
          orchardGeometry ||= new THREE.SphereGeometry(.5, 6, 4);
          const trees = new THREE.InstancedMesh(orchardGeometry, new THREE.MeshStandardMaterial({color: 0x417c43, roughness: .95}), plants.length);
          const matrix = new THREE.Matrix4();
          plants.forEach((p, i) => trees.setMatrixAt(i, matrix.makeTranslation(p.x, p.y, p.z)));
          trees.instanceMatrix.needsUpdate = true;
          trees.userData = {kind: "orchard", parcelId: parcel.id};
          mesh.add(trees);
        }
        floorMeshes.push(mesh); fieldPickMeshes.push(mesh); parcelGroup.add(mesh);
      }
      parcel.buildings.forEach(building => buildStructure(parcel, building, parcelIndex));
    }

    function buildStructure(parcel, building, parcelIndex) {
      const {x, z} = building.position;
      const bw = building.w;
      const bd = building.d;
      const fh = building.floor_h;

      const geo = polygonGeometry(building.footprint, fh * .88);
      const edgeGeo = new THREE.EdgesGeometry(geo);
      const bandGeo = polygonGeometry(building.footprint.map(p => ({x: p.x * 1.04, z: p.z * 1.04})), fh * .09);
      const facades = Array.from({length: Math.min(3, building.floors.length)}, (_, i) => sceneVisuals.facadeGeometry(building, i + parcelIndex));

      building.floors.forEach((floor, floorIndex) => {
        const shrink = 1;
        const baseColor = colorForFloor(floor, parcel, floorIndex);
        const wallColor = sceneVisuals.palette.walls[parcelIndex % sceneVisuals.palette.walls.length];
        const mat = new THREE.MeshStandardMaterial({
          color: wallColor,
          roughness: 0.75,
          metalness: 0.08,
          transparent: true,
          opacity: 1,
          emissive: new THREE.Color(sceneVisuals.palette.cyan),
          emissiveIntensity: 0
        });
        const mesh = new THREE.Mesh(geo, mat);
        mat.color.convertSRGBToLinear();
        mat.emissive.convertSRGBToLinear();
        const baseY = building.position.y + (fh * 0.52) + floorIndex * fh;
        mesh.position.set(x, baseY, z);
        mesh.scale.set(shrink, 1, shrink);
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        mesh.userData = {
          kind: "floor",
          buildingId: building.id,
          building,
          parcelId: parcel.id,
          floorId: floor.id,
          floorIndex,
          baseOpacity: 1,
          baseColor,
          baseY,
          baseScale: shrink,
          phase: parcelIndex * 0.9 + floorIndex * 0.42,
          delay: parcelIndex * .065 + floorIndex * .075,
          explodeY: 0
        };

        const edgeMat = new THREE.LineBasicMaterial({
          color: sceneVisuals.palette.cyan,
          transparent: true,
          opacity: 0.28
        });
        const edges = new THREE.LineSegments(edgeGeo, edgeMat);
        edges.userData.kind = "floor-edges";
        mesh.add(edges);

        const glowMat = new THREE.LineBasicMaterial({
          color: sceneVisuals.palette.cyan,
          transparent: true,
          opacity: 0.0
        });
        const glow = new THREE.LineSegments(edgeGeo, glowMat);
        glow.scale.setScalar(1.012);
        glow.userData.kind = "hover-glow";
        mesh.add(glow);

        const facade = new THREE.Mesh(facades[floorIndex % facades.length], new THREE.MeshBasicMaterial({vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 1}));
        facade.userData.kind = "facade";
        mesh.add(facade);

        floorMeshes.push(mesh);
        buildingPickMeshes.push(mesh);
        buildingGroup.add(mesh);

        const bandMat = sceneVisuals.surface({ color: sceneVisuals.palette.concrete, roughness: .8, transparent: true, opacity: 1, emissive: sceneVisuals.palette.cyan, emissiveIntensity: 0 });
        const band = new THREE.Mesh(bandGeo, bandMat);
        band.position.set(0, fh * 0.46, 0);
        band.userData = { kind: "floor-band", parentFloor: floor.id, phase: floorIndex * 0.55 };
        mesh.add(band);
      });

      const roofGeo = polygonGeometry(building.footprint.map(p => ({x: p.x * .94, z: p.z * .94})), .16);
      const roofMat = new THREE.MeshStandardMaterial({ color: sceneVisuals.palette.roof, roughness: .85, metalness: .08 });
      roofMat.color.convertSRGBToLinear();
      roofMat.emissive.convertSRGBToLinear();
      const roof = new THREE.Mesh(roofGeo, roofMat);
      roof.position.set(x, building.position.y + building.height + 0.1, z);
      roof.castShadow = true;
      roof.userData = { kind: "roof", buildingId: building.id, parcelId: parcel.id, baseY: roof.position.y, level: building.floors.length - 1, delay: parcelIndex * .065 + building.floors.length * .075 };
      buildingGroup.add(roof);
      buildingDecor.push(roof);
      panelGeometry ||= new THREE.BoxGeometry(1, 1, 1);
      const panels = new THREE.InstancedMesh(panelGeometry, new THREE.MeshStandardMaterial({ color: 0x23495e, metalness: .65, roughness: .24, emissive: 0x39c8f2, emissiveIntensity: .16 }), 3);
      const panelTransform = new THREE.Object3D();
      panelTransform.rotation.x = -.16;
      panelTransform.scale.set(bw * .18, .09, bd * .35);
      for (let i = 0; i < 3; i++) {
        panelTransform.position.set((i - 1) * bw * .24, .19, 0);
        panelTransform.updateMatrix();
        panels.setMatrixAt(i, panelTransform.matrix);
      }
      panels.instanceMatrix.needsUpdate = true;
      roof.add(panels);

      beaconGeometry ||= new THREE.OctahedronGeometry(.45);
      const beaconMat = new THREE.MeshBasicMaterial({ color: statusColor(parcel), transparent: true, opacity: 0.85, wireframe: parcel.status.includes("Disputed") });
      const beacon = new THREE.Mesh(beaconGeometry, beaconMat);
      beacon.position.set(x, building.position.y + building.height + 1.05, z);
      beacon.userData = { kind: "beacon", buildingId: building.id, parcelId: parcel.id, phase: parcelIndex * 0.8, baseY: beacon.position.y, level: building.floors.length - 1, delay: roof.userData.delay, explodeY: 0 };
      buildingGroup.add(beacon);
      buildingDecor.push(beacon);

      const scanGeo = new THREE.BufferGeometry().setFromPoints(building.footprint.map(p => new THREE.Vector3(p.x * 1.03, 0, p.z * 1.03)));
      const scanner = new THREE.LineLoop(scanGeo, new THREE.LineBasicMaterial({ color: 0xf0fff9, transparent: true, opacity: .6 }));
      scanner.position.set(x, 0, z);
      buildingGroup.add(scanner);
      surveyFrames.push({ scanner, parcel, building, phase: parcelIndex * .09 });
      roof.userData.meshes = [roof, panels, ...sceneVisuals.rooftop(roof, building)];

      const podiumGeo = polygonGeometry(building.footprint.map(p => ({x: p.x * 1.08, z: p.z * 1.08})), .22);
      podiumMaterial ||= sceneVisuals.surface({ color: 0x888d83, roughness: .95, metalness: 0 });
      const podium = new THREE.Mesh(podiumGeo, podiumMaterial);
      podium.position.set(x, building.position.y + 0.02, z);
      podium.receiveShadow = true;
      podium.userData = { kind: "podium", parcelId: parcel.id };
      buildingGroup.add(podium);
    }

    function buildParcelScene() {
      floorMeshes.length = 0;
      buildingDecor.length = 0;
      parcelTracers.length = 0;
      parcelPickMeshes.length = 0;
      buildingPickMeshes.length = 0;
      fieldPickMeshes.length = 0;
      surveyFrames.length = 0;
      disposeGroup(parcelGroup);
      disposeGroup(buildingGroup);
      panelGeometry = beaconGeometry = orchardGeometry = podiumMaterial = null;
      state.sceneParcels.forEach((parcel, i) => {
        makeParcelBoundary(parcel);
        buildBuilding(parcel, i);
      });
      land.areas.filter(area => area.id === state.activeAreaId && state.sceneParcels.length).forEach(area => {
        const parcels = state.sceneParcels;
        const canvas = document.createElement("canvas"); canvas.width = 512; canvas.height = 64;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#d8efdf"; ctx.font = "600 28px system-ui"; ctx.textAlign = "center";
        ctx.fillText(`${area.district} / ${area.state_code}`, 256, 42);
        const label = new THREE.Sprite(new THREE.SpriteMaterial({map: new THREE.CanvasTexture(canvas), transparent:true, depthTest:false}));
        label.position.set(parcels.reduce((n,p)=>n+p.position.x,0)/parcels.length, 1, Math.max(...parcels.map(p=>p.position.z+p.size.d/2))+4);
        label.scale.set(30,3.75,1); label.userData = {kind: "area-label", areaId: area.id}; parcelGroup.add(label);
      });
    }

    function buildUndergroundScene() {
      undergroundAssets = [];
      disposeGroup(pipelineGroup); disposeGroup(undergroundGroup);
      const network = sceneVisuals.undergroundNetwork(undergroundGroup, state.sceneParcels);
      undergroundAssets = network.assets;
      pipelineGroup.add(...undergroundGroup.children.filter(o => ["water","sewer","gas","drainage","industrial"].includes(o.userData.category)).map(o => { undergroundGroup.remove(o); return o; }));
      pipelineGroup.visible = true; undergroundGroup.visible = true;
    }

    function updateSceneTheme() {
      if (!scene || !renderer) return;
      const light = document.body.classList.contains("light-theme");
      scene.fog.color.set(light ? 0xb5c6c3 : 0x253639);
      scene.fog.density = state.activeAreaId === "HYD" ? .005 : .003;
      renderer.setClearColor(light ? 0xb5c6c3 : 0x253639, 1);

      terrainGroup.traverse(obj => {
        if (obj.isMesh && obj.userData.kind === "ground") {
          obj.material.color.set(sceneVisuals.groundColor(state.activeAreaId)).convertSRGBToLinear();
          if (light) obj.material.color.multiplyScalar(1.35);
          obj.material.opacity = 1;
        }
      });
      const cutaway = $("groundCutaway")?.checked;
      terrainGroup.traverse(obj => { if (obj.userData.kind === "ground") { obj.material.transparent = Boolean(cutaway); obj.material.opacity = cutaway ? .18 : 1; } });
    }

    function getFloorMesh(parcelId, floorId) {
      return floorMeshes.find(m => m.userData.parcelId === parcelId && m.userData.floorId === floorId);
    }

    function setFloorHover(mesh, active) {
      if (!mesh) return;
      mesh.userData.hovered = active;
    }

    function setParcelHover(mesh, active) {
      if (!mesh) return;
      mesh.userData.hovered = active;
      const parcel = state.parcels.find(p => p.id === mesh.userData.parcelId);
      if (mesh.userData.kind === "parcel-fill") {
        mesh.material.opacity = active ? 0.16 : 0.065;
      } else if (mesh.userData.kind === "parcel-boundary") {
        mesh.material.opacity = active ? 1 : 0.86;
      } else if (mesh.userData.kind === "parcel-tracer") {
        mesh.material.opacity = active ? 1 : 0.95;
      }
    }

    function updateParcelWeatherPanel(parcel) {
      if (!parcel) {
        $("parcelWeatherTitle").textContent = "No parcel selected";
        $("parcelWeatherRank").textContent = "";
        $("parcelWeatherDetails").replaceChildren();
        $("parcelWeatherNote").textContent = "";
        return;
      }
      const weather = state.weatherByParcel[parcel.id];
      const result = siteParcelScore(parcel);
      const rank = state.siteRanking.findIndex(x => x.id === parcel.id) + 1;
      $("parcelWeatherTitle").textContent = `${parcel.id} · ${parcel.land_use}`;
      $("parcelWeatherRank").textContent = rank > 0 ? `#${rank} of ${state.sceneParcels.length}` : "Parcel";
      $("parcelWeatherDetails").innerHTML = `
        <div class="metric"><div class="metric-label">Temperature</div><div class="metric-value">${weather ? `${weather.temperature.toFixed(1)}°C` : "Loading…"}</div></div>
        <div class="metric"><div class="metric-label">Rainfall</div><div class="metric-value">${weather ? `${weather.precipitation.toFixed(1)} mm` : "Loading…"}</div></div>
        <div class="metric"><div class="metric-label">Wind</div><div class="metric-value">${weather ? `${weather.wind_speed.toFixed(1)} km/h` : "Loading…"}</div></div>
        <div class="metric"><div class="metric-label">Soil</div><div class="metric-value">${escapeHtml(parcel.soil?.type || "Regional estimate")}</div></div>
        <div class="metric"><div class="metric-label">Site Score</div><div class="metric-value site-score">${result.score}/100</div></div>
        <div class="metric"><div class="metric-label">Recommendation</div><div class="metric-value site-recommendation">${result.score >= 80 ? "Best choice" : result.score >= 65 ? "Consider" : "Lower priority"}</div></div>
      `;
      $("parcelWeatherNote").textContent = weather
        ? `${weather.source}. ${result.weather.label}. Synthetic soil: ${parcel.soil?.type} (${result.soilScore}/100).`
        : "Fetching weather for this parcel…";
    }

    function updateConflictWarningChip(conflict) {
      if (!conflict) return;
      $("selectionChip").classList.add("overlap-alert");
      $("selectionChip").innerHTML = `
        <strong style="color:var(--danger)">Overlap Warning</strong><br>
        ${escapeHtml(conflict.parcel_a)} overlaps ${escapeHtml(conflict.parcel_b)}
        <br><span class="floor-code">${conflict.overlap_percent.toFixed(1)}% ${escapeHtml(conflict.severity)} risk - run geometry check</span>
      `;
    }

    function setConflictHover(mesh, active) {
      if (!mesh) return;
      const data = mesh.userData;
      mesh.userData.hovered = active;
      mesh.material.color.set(active ? 0xff1f3d : data.baseColor);
      mesh.material.opacity = active ? 0.32 : data.baseOpacity;
      mesh.children.forEach(child => {
        if (child.userData.kind === "conflict-edges") {
          child.material.color.set(active ? 0xffd6dc : data.edgeColor);
          child.material.opacity = active ? 1 : data.edgeOpacity;
        }
      });
    }

    function onPointerMove(event) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, activeCamera);
      const conflictHits = riskGroup?.visible ? raycaster.intersectObjects(riskGroup.children, false) : [];
      const nextConflict = conflictHits.length ? conflictHits[0].object : null;
      let changed = nextConflict !== hoveredConflict;
      if (nextConflict !== hoveredConflict) {
        setConflictHover(hoveredConflict, false);
        hoveredConflict = nextConflict;
        setConflictHover(hoveredConflict, true);
      }
      const buildingHits = buildingGroup.visible ? raycaster.intersectObjects(buildingPickMeshes, false) : [];
      const infraHits = (pipelineGroup?.visible || undergroundGroup?.visible) ? raycaster.intersectObjects([...(pipelineGroup?.visible ? pipelineGroup.children : []), ...(undergroundGroup?.visible ? undergroundGroup.children : [])], false) : [];
      const nextInfrastructure = infraHits.length ? infraHits[0].object : null;
      if (nextInfrastructure !== hoveredInfrastructure) { changed = true; hoveredInfrastructure = nextInfrastructure; }
      if (hoveredInfrastructure) { hoveredInfrastructure.scale.setScalar(hoveredInfrastructure.userData.hovered ? 1.35 : 1); hoveredInfrastructure.userData.hovered = true; }
      const hits = buildingHits.length ? buildingHits : parcelGroup.visible ? raycaster.intersectObjects(fieldPickMeshes, false) : [];
      const next = hits.length ? hits[0].object : null;
      const parcelHits = !next && parcelGroup.visible ? raycaster.intersectObjects(parcelPickMeshes, false) : [];
      const nextParcel = parcelHits.find(hit => hit.object.userData?.parcelId)?.object || null;

      if (next !== hoveredFloor) {
        changed = true;
        setFloorHover(hoveredFloor, false);
        hoveredFloor = next;
        setFloorHover(hoveredFloor, true);
      }
      if (nextParcel !== hoveredParcel) {
        changed = true;
        setParcelHover(hoveredParcel, false);
        hoveredParcel = nextParcel;
        setParcelHover(hoveredParcel, true);
      }
      if (!changed) return;
      renderer.domElement.style.cursor = hoveredConflict || hoveredFloor || hoveredParcel || hoveredInfrastructure ? "pointer" : "grab";

      if (hoveredConflict) {
        const conflict = state.preflightOverlaps.find(item => item.id === hoveredConflict.userData.conflictId);
        updateConflictWarningChip(conflict);
      } else if (hoveredInfrastructure) {
        const a = hoveredInfrastructure.userData;
        $("undergroundInspector").innerHTML = `<div class="metric"><div class="metric-label">Asset</div><div class="metric-value">${escapeHtml(a.assetId)}</div></div><div class="metric"><div class="metric-label">Type</div><div class="metric-value">${escapeHtml(a.infrastructureType)}</div></div><div class="metric"><div class="metric-label">Depth</div><div class="metric-value">${a.depth} m below ground</div></div><div class="metric"><div class="metric-label">Dimensions</div><div class="metric-value">${escapeHtml(a.dimensions)}</div></div><div class="metric"><div class="metric-label">Owner</div><div class="metric-value">${escapeHtml(a.ownership)}</div></div><div class="metric"><div class="metric-label">Status</div><div class="metric-value">${escapeHtml(a.status)}</div></div>`;
      } else if (hoveredFloor) {
        const parcel = state.parcelById.get(hoveredFloor.userData.parcelId);
        const building = hoveredFloor.userData.building || null;
        const floor = (building?.floors || parcel.floors).find(f => f.id === hoveredFloor.userData.floorId);
        updateSelectionChip(parcel, floor, building);
        if (parcel) updateParcelWeatherPanel(parcel);
      } else if (hoveredParcel) {
        const parcel = state.parcelById.get(hoveredParcel.userData.parcelId);
        updateSelectionChip(parcel, parcel?.floors[0], null);
        if (parcel) updateParcelWeatherPanel(parcel);
      } else {
        updateSelectionChip();
        const fallback = state.selectedParcel;
        if (fallback) updateParcelWeatherPanel(fallback);
      }
    }

    function clearHover() {
      pendingPointer = null;
      setFloorHover(hoveredFloor, false);
      setParcelHover(hoveredParcel, false);
      setConflictHover(hoveredConflict, false);
      hoveredFloor = null;
      hoveredParcel = null;
      hoveredConflict = null;
      hoveredInfrastructure = null;
      renderer.domElement.style.cursor = "grab";
      updateSelectionChip();
      updateParcelWeatherPanel(state.selectedParcel);
    }

    function onViewportClick() {
      if (hoveredInfrastructure) { $("undergroundInspector").scrollIntoView?.({block:"nearest"}); renderStillFrame(); return; }
      const id = hoveredFloor?.userData.parcelId || hoveredParcel?.userData.parcelId;
      if (!id) return;
      if (land.ready && $("landMulti").checked) {
        if (land.selected.has(id)) land.selected.delete(id); else land.selected.add(id);
        $("landPackage").value = "";
        landSelectionChanged();
      }
      if (hoveredFloor) selectFloor(id, hoveredFloor.userData.floorId, true, false);
      else selectParcelById(id, true);
      clearIsolation(); renderStillFrame();
    }

    function isolateFloor(parcelId, floorId) {
      isolation = { parcelId, floorId };
    }

    function clearIsolation() {
      isolation = null;
    }

    function tweenCamera(camera, targetPosition, targetLookAt, duration = 850) {
      if (reducedMotion.matches || duration === 0) {
        camera.position.copy(targetPosition);
        controls.target.copy(targetLookAt);
        camera.lookAt(targetLookAt);
        cameraTween = null;
        renderStillFrame();
        return;
      }
      const start = performance.now();
      const fromPos = camera.position.clone();
      const fromTarget = controls.target.clone();
      cameraTween = { camera, start, duration, fromPos, fromTarget, targetPosition, targetLookAt };
      requestSceneFrame();
    }

    function updateCameraTween(now) {
      if (!cameraTween) return;
      const t = Math.min(1, (now - cameraTween.start) / cameraTween.duration);
      const eased = 1 - Math.pow(1 - t, 3);
      cameraTween.camera.position.lerpVectors(cameraTween.fromPos, cameraTween.targetPosition, eased);
      controls.target.lerpVectors(cameraTween.fromTarget, cameraTween.targetLookAt, eased);
      if (t >= 1) cameraTween = null;
    }

    function focusFloor(parcelId, floorId) {
      if (!state.sceneReady) return;
      setOrbit(false);
      if (state.activeView !== "3d") set3DView(false);
      const mesh = getFloorMesh(parcelId, floorId);
      if (!mesh) return;
      const bounds = new THREE.Box3().setFromObject(mesh);
      const center = bounds.getCenter(new THREE.Vector3());
      const size = bounds.getSize(new THREE.Vector3());
      const distance = Math.max(14, Math.max(size.x, size.y, size.z) * 3.2) / Math.min(1, perspectiveCamera.aspect);
      const targetPos = center.clone().add(new THREE.Vector3(1, .68, 1).normalize().multiplyScalar(distance));
      tweenCamera(perspectiveCamera, targetPos, center, 800);
    }

    function focusParcel(parcelId) {
      if (!state.sceneReady) return;
      setOrbit(false);
      const parcel = state.parcels.find(p => p.id === parcelId);
      if (!parcel) return;
      if (state.activeView !== "3d") set3DView(false);
      clearIsolation();
      const height = buildingHeight(parcel) + (motion.exploded ? Math.max(0, ...parcel.buildings.map(b => b.floors.length - 1)) * 1.35 : 0);
      const center = new THREE.Vector3(parcel.position.x, height / 2, parcel.position.z);
      const offset = Math.max(20, height * 1.05) / Math.min(1, perspectiveCamera.aspect);
      const targetPos = center.clone().add(new THREE.Vector3(offset, offset * .72, offset));
      tweenCamera(perspectiveCamera, targetPos, center, 850);
    }

    function rebindControls(camera) {
      const oldTarget = controls.target.clone();
      controls.dispose();
      controls = new THREE.OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.065;
      controls.target.copy(oldTarget);
      controls.minDistance = 7;
      controls.maxDistance = 1800;
      controls.maxPolarAngle = camera === orthoCamera ? Math.PI : Math.PI * 0.49;
      controls.enableRotate = camera !== orthoCamera;
      bindOrbitInteraction();
    }

    function set3DView(reset = true) {
      if (!state.sceneReady) return;
      if (activeCamera !== perspectiveCamera) {
        activeCamera = perspectiveCamera;
        rebindControls(activeCamera);
      }
      state.activeView = "3d";
      $("view3D").classList.add("active");
      $("view2D").classList.remove("active");
      syncMotionControls();
      if (reset) resetCamera();
    }

    function set2DView() {
      if (!state.sceneReady) return;
      cameraTween = null;
      motion.exploded = false;
      setOrbit(false);
      activeCamera = orthoCamera;
      const center = sceneBounds.getCenter(new THREE.Vector3());
      const tx = center.x;
      const tz = center.z;
      orthoCamera.position.set(tx, 55, tz + 0.01);
      orthoCamera.up.set(0, 0, -1);
      orthoCamera.lookAt(tx, 0, tz);
      rebindControls(activeCamera);
      controls.target.set(tx, 0, tz);
      state.activeView = "2d";
      $("view3D").classList.remove("active");
      $("view2D").classList.add("active");
      clearIsolation();
      syncMotionControls();
    }

    function resetCamera(immediate = false) {
      if (!state.sceneReady) return;
      clearIsolation();
      motion.exploded = false;
      const center = sceneBounds.getCenter(new THREE.Vector3());
      if (state.activeView === "2d") {
        cameraTween = null;
        orthoCamera.zoom = 1;
        orthoCamera.updateProjectionMatrix();
        orthoCamera.position.set(center.x, 70, center.z + .01);
        controls.target.set(center.x, 0, center.z);
      } else {
        center.y *= .45;
        const radius = sceneBounds.getBoundingSphere(new THREE.Sphere()).radius;
        const halfFov = THREE.MathUtils.degToRad(perspectiveCamera.fov / 2);
        const limitingFov = Math.atan(Math.tan(halfFov) * Math.min(1, perspectiveCamera.aspect));
        const distance = radius * 1.12 / Math.sin(limitingFov);
        const direction = new THREE.Vector3(.88, .95, 1).normalize();
        tweenCamera(
          perspectiveCamera,
          center.clone().addScaledVector(direction, distance),
          center,
          immediate ? 0 : 1100
        );
      }
      updateSelectionChip();
      syncMotionControls();
    }

    function makeConflictVolume(conflict, { active = false } = {}) {
      const v = conflict.scene_volume;
      const geo = new THREE.BoxGeometry(v.w, v.h, v.d);
      const baseColor = active ? 0xff2f4f : conflict.severity === "High" ? 0xff6577 : 0xffc857;
      const edgeColor = active ? 0xff6577 : conflict.severity === "High" ? 0xff8a98 : 0xffd482;
      const baseOpacity = active ? 0.16 : 0.105;
      const edgeOpacity = active ? 0.95 : 0.54;
      const mat = new THREE.MeshBasicMaterial({
        color: baseColor,
        transparent: true,
        opacity: baseOpacity,
        depthWrite: false
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(v.x, v.y, v.z);
      mesh.userData = {
        kind: active ? "active-conflict" : "preflight-conflict",
        conflictId: conflict.id,
        parcelA: conflict.parcel_a,
        parcelB: conflict.parcel_b,
        baseColor,
        edgeColor,
        baseOpacity,
        edgeOpacity
      };

      const edgeGeo = new THREE.EdgesGeometry(geo);
      const edgeMat = new THREE.LineBasicMaterial({
        color: edgeColor,
        transparent: true,
        opacity: edgeOpacity
      });
      const edges = new THREE.LineSegments(edgeGeo, edgeMat);
      edges.scale.setScalar(1.02);
      edges.userData.kind = "conflict-edges";
      mesh.add(edges);
      return { mesh, edges };
    }

    function updatePreflightOverlapEmphasis() {
      if (!riskGroup) return;
      const selected = state.selectedParcel?.id;
      riskGroup.children.forEach(mesh => {
        const related = selected && (mesh.userData.parcelA === selected || mesh.userData.parcelB === selected);
        if (!mesh.userData.hovered) mesh.material.opacity = related ? 0.16 : 0.07;
        mesh.userData.baseOpacity = related ? 0.16 : 0.07;
        mesh.children.forEach(child => {
          if (child.userData.kind === "conflict-edges") {
            if (!mesh.userData.hovered) child.material.opacity = related ? 0.78 : 0.34;
            mesh.userData.edgeOpacity = related ? 0.78 : 0.34;
          }
        });
      });
      renderStillFrame();
    }

    function renderPreflightOverlapVolumes() {
      if (!riskGroup) return;
      disposeGroup(riskGroup);
      visibleConflicts().forEach(conflict => {
        const { mesh } = makeConflictVolume(conflict, { active: false });
        riskGroup.add(mesh);
      });
      const visible = document.querySelector('[data-layer="conflict"]')?.classList.contains("on") ?? true;
      riskGroup.visible = visible;
      updatePreflightOverlapEmphasis();
    }

    function renderConflictVolume(conflict) {
      clearConflictVolume();
      const { mesh, edges } = makeConflictVolume(conflict, { active: true });

      conflictGroup.add(mesh);
      conflictPulse = { mesh, edges, start: motion.time * 1000 };
      const a = state.parcels.find(p => p.id === conflict.parcel_a);
      const b = state.parcels.find(p => p.id === conflict.parcel_b);
      if (a && b) {
        const start = new THREE.Vector3(a.position.x, buildingHeight(a) + 1, a.position.z);
        const end = new THREE.Vector3(b.position.x, buildingHeight(b) + 1, b.position.z);
        const middle = start.clone().lerp(end, .5);
        middle.y = Math.max(start.y, end.y) + 5;
        const curve = new THREE.QuadraticBezierCurve3(start, middle, end);
        const link = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(64)), new THREE.LineDashedMaterial({ color: 0xff6577, transparent: true, opacity: .75, dashSize: .45, gapSize: .22 }));
        link.computeLineDistances();
        conflictGroup.add(link);
        const markers = Array.from({ length: 3 }, () => {
          const marker = new THREE.Mesh(new THREE.BoxGeometry(.22, .22, .22), new THREE.MeshBasicMaterial({ color: 0xffb7b9 }));
          conflictGroup.add(marker);
          return marker;
        });
        Object.assign(conflictPulse, { curve, markers });
      }
      conflictGroup.visible = document.querySelector('[data-layer="conflict"]').classList.contains("on");
      renderStillFrame();
    }

    function clearConflictVolume() {
      disposeGroup(conflictGroup);
      conflictPulse = null;
      $("overlapWarning")?.classList.remove("show");
    }

    function animateConflict(now) {
      if (!conflictPulse) return;
      const phase = (now - conflictPulse.start) / 1000;
      conflictPulse.mesh.material.opacity = 0.11 + (Math.sin(phase * 4) + 1) * 0.055;
      conflictPulse.edges.material.opacity = 0.55 + (Math.sin(phase * 5) + 1) * 0.20;
      const s = 1 + (Math.sin(phase * 3) + 1) * 0.004;
      conflictPulse.edges.scale.setScalar(1.015 * s);
      conflictPulse.markers?.forEach((marker, i) => {
        conflictPulse.curve.getPointAt((phase * .16 + i / 3) % 1, marker.position);
        marker.rotation.y = phase;
      });
    }

    function onResize3D() {
      if (!renderer) return;
      const container = $("viewport");
      const w = Math.max(1, container.clientWidth);
      const h = Math.max(1, container.clientHeight);
      const previousAspect = perspectiveCamera.aspect;
      const size = renderer.getSize(new THREE.Vector2());
      if (size.x !== w || size.y !== h) renderer.setSize(w, h, false);
      if (previousAspect !== w / h) {
        perspectiveCamera.aspect = w / h;
        perspectiveCamera.updateProjectionMatrix();
      }

      const aspect = w / h;
      const boundsSize = sceneBounds.getSize(new THREE.Vector3());
      const frustum = Math.max(boundsSize.z + 14, (boundsSize.x + 14) / aspect);
      orthoCamera.left = -frustum * aspect / 2;
      orthoCamera.right = frustum * aspect / 2;
      orthoCamera.top = frustum / 2;
      orthoCamera.bottom = -frustum / 2;
      orthoCamera.updateProjectionMatrix();
      if (!rebuildingScene && state.sceneReady && state.activeView === "3d" && window.matchMedia("(max-width:640px)").matches && Math.abs(previousAspect - w/h) > .03) {
        if (state.sceneParcels.some(p => land.selected.has(p.id))) fitLandSelection();
        else resetCamera(true);
      }
      if (!rebuildingScene && !isSceneMotionActive()) renderer.render(scene, activeCamera);
    }

    function scheduleResize3D() {
      if (resize3DFrame !== null) return;
      resize3DFrame = requestAnimationFrame(() => {
        resize3DFrame = null;
        onResize3D();
      });
    }

    function bindOrbitInteraction() {
      controls.addEventListener("start", () => {
        cameraTween = null;
        setOrbit(false);
      });
    }

    function setOrbit(enabled) {
      motion.orbit = enabled && state.activeView === "3d";
      syncMotionControls();
    }

    function syncMotionControls() {
      document.body.classList.toggle("motion-paused", !motion.enabled);
      if (controls) {
        if (!motion.enabled) {
          if (cameraTween) tweenCamera(cameraTween.camera, cameraTween.targetPosition, cameraTween.targetLookAt, 0);
          const position = activeCamera.position.clone();
          const target = controls.target.clone();
          controls.autoRotate = false;
          controls.enableDamping = false;
          // Flush OrbitControls inertia while preserving the paused camera pose.
          controls.update();
          activeCamera.position.copy(position);
          controls.target.copy(target);
          controls.update();
        } else controls.enableDamping = isSceneMotionActive();
      }
      const label = motion.enabled ? "Pause animations" : "Play animations";
      $("motionToggle").setAttribute("aria-label", label);
      $("motionToggle").dataset.tooltip = label;
      $("motionToggle").innerHTML = `<i data-lucide="${motion.enabled ? "pause" : "play"}" width="14" height="14"></i>`;
      $("motionState").textContent = motion.enabled ? (isSceneMotionActive() ? "LIVE" : "HOVER") : "PAUSED";
      for (const [id, enabled] of [["motionToggle", motion.enabled], ["orbitToggle", motion.orbit], ["scanToggle", motion.scan], ["explodeView", motion.exploded], ["view3D", state.activeView === "3d"], ["view2D", state.activeView === "2d"]]) {
        $(id).classList.toggle("active", enabled);
        $(id).setAttribute("aria-pressed", String(enabled));
      }
      $("orbitToggle").disabled = !state.sceneReady || state.activeView !== "3d";
      $("explodeView").disabled = !state.sceneReady || state.activeView !== "3d" || !state.selectedParcel;
      $("replayScene").disabled = !state.sceneReady || !motion.enabled || reducedMotion.matches;
      lucide.createIcons();
    }

    function toggleExplosion() {
      if (!state.sceneReady || state.activeView !== "3d" || !state.selectedParcel) return;
      motion.exploded = !motion.exploded;
      focusParcel(state.selectedParcel.id);
      syncMotionControls();
    }

    function replayAssembly() {
      if (!state.sceneReady || !motion.enabled || reducedMotion.matches) return;
      assemblyStart = motion.time;
      set3DView(false);
      resetCamera();
      setOrbit(true);
    }

    function animateSpatialLayers(delta) {
      const activeMotion = isSceneMotionActive();
      const seconds = motion.time;
      const blend = activeMotion ? 1 - Math.exp(-delta * 11) : 1;
      const assembly = activeMotion ? seconds - assemblyStart : 100;
      const progressFor = delay => {
        const t = THREE.MathUtils.clamp((assembly - delay) / 1.2, 0, 1);
        return 1 - Math.pow(1 - t, 3);
      };
      const scanZ = sceneBounds.min.z - 4 + (seconds * .09 % 1) * (sceneBounds.max.z - sceneBounds.min.z + 8);
      sweep.position.z = scanZ;
      sweep.visible = activeMotion && motion.scan;

      floorMeshes.forEach(mesh => {
        const data = mesh.userData;
        const parcel = state.parcelById.get(data.parcelId);
        const classMatch = !state.legendClass || sceneVisuals.classification(parcel) === state.legendClass;
        const classColor = colorForParcel(parcel);
        const selected = isolation?.parcelId === data.parcelId && isolation?.floorId === data.floorId;
        const sameParcel = isolation?.parcelId === data.parcelId;
        const expanded = motion.exploded && state.selectedParcel?.id === data.parcelId;
        const assembled = progressFor(data.delay);
        data.explodeY = THREE.MathUtils.lerp(data.explodeY, expanded ? data.floorIndex * 1.35 : 0, blend);
        mesh.visible = assembled > .001;
        mesh.position.y = data.baseY + data.explodeY + (1 - assembled) * 7;
        const architectural = data.kind === "floor";
        const scale = data.hovered ? 1.012 : selected ? 1.008 : 1;
        mesh.scale.x = mesh.scale.z = THREE.MathUtils.lerp(mesh.scale.x, data.baseScale * scale, blend);
        mesh.scale.y = Math.max(.02, assembled) * mesh.scale.x / data.baseScale;
        const opacity = (isolation ? selected || data.hovered ? 1 : architectural ? .96 : sameParcel ? .24 : .11 : motion.exploded && !expanded ? .075 : data.baseOpacity) * assembled * (classMatch ? 1 : .22);
        mesh.material.opacity = THREE.MathUtils.lerp(mesh.material.opacity, opacity, blend);
        mesh.material.depthWrite = mesh.material.opacity > .5;
        const scanGlow = activeMotion && motion.scan && terrainGroup.visible ? Math.max(0, 1 - Math.abs(mesh.position.z - scanZ) / 3) * .38 : 0;
        const classified = state.legendClass && classMatch;
        mesh.material.emissive.setHex(classified && !selected && !data.hovered ? classColor : sceneVisuals.palette.cyan).convertSRGBToLinear();
        const glow = architectural ? data.hovered ? .65 : selected ? .48 : classified ? .25 : scanGlow * .08 : data.hovered ? .2 : selected ? .12 : classified ? .2 : 0;
        mesh.material.emissiveIntensity = THREE.MathUtils.lerp(mesh.material.emissiveIntensity, glow, blend);
        mesh.children.forEach(child => {
          const kind = child.userData.kind;
          if (kind === "hover-glow") {
            child.material.opacity = THREE.MathUtils.lerp(child.material.opacity, data.hovered || selected ? .95 : 0, blend);
            child.visible = child.material.opacity > .01;
          }
          if (kind === "floor-edges") {
            child.material.opacity = mesh.material.opacity * (selected ? .9 : state.selectedParcel?.id === data.parcelId ? .18 : 0);
            child.visible = child.material.opacity > .01;
          }
          if (kind === "facade") {
            child.material.opacity = mesh.material.opacity * (selected || data.hovered ? .6 : 1);
            child.material.depthWrite = mesh.material.opacity > .5;
          }
          if (kind === "floor-band") {
            child.material.opacity = mesh.material.opacity;
            child.material.emissive.setHex(selected || data.hovered ? sceneVisuals.palette.cyan : classColor).convertSRGBToLinear();
            child.material.emissiveIntensity = selected || data.hovered ? .85 : classified ? .5 : 0;
            child.material.depthWrite = mesh.material.opacity > .5;
          }
          if (kind === "crop-beds" || kind === "crop-furrows" || kind === "crop-plants") child.material.opacity = mesh.material.opacity;
        });
      });

      buildingDecor.forEach(obj => {
        const data = obj.userData;
        const expanded = motion.exploded && state.selectedParcel?.id === data.parcelId;
        data.explodeY = THREE.MathUtils.lerp(data.explodeY || 0, expanded ? data.level * 1.35 : 0, blend);
        const assembled = progressFor(data.delay);
        obj.visible = assembled > .02;
        obj.position.y = data.baseY + data.explodeY + (1 - assembled) * 7;
        obj.scale.setScalar(Math.max(.01, assembled));
        if (data.kind === "beacon") {
          obj.rotation.y = seconds * .8 + data.phase;
          obj.position.y += Math.sin(seconds * 1.8 + data.phase) * .2;
          obj.material.opacity = motion.exploded && !expanded ? .08 : .65 + Math.sin(seconds * 2 + data.phase) * .2;
        }
        if (data.kind === "roof") {
          data.meshes.forEach(child => {
            child.material.transparent = true;
            const classMatch = !state.legendClass || sceneVisuals.classification(state.parcelById.get(data.parcelId)) === state.legendClass;
            child.material.opacity = motion.exploded && !expanded ? .06 : assembled * (classMatch ? 1 : .22);
            child.material.depthWrite = !motion.exploded || expanded;
          });
        }
      });

      const hazard = $("landLayer")?.value;
      parcelTracers.forEach(record => {
        const { trail, parcel, fill, line, phase } = record;
        if (activeMotion) {
          const positions = trail.geometry.attributes.position;
          for (let i = 0; i < positions.count; i++) {
            const point = boundaryPoint(parcel, seconds * .12 + phase - i * .009, .12, sceneScratch);
            positions.setXYZ(i, point.x, point.y, point.z);
          }
          positions.needsUpdate = true;
        }
        fill.material.opacity = (land.selected.has(parcel.id) ? .16 : .035) + Math.max(0, 1 - Math.abs(parcel.position.z - scanZ) / 4) * (activeMotion && motion.scan ? .06 : 0);
        const riskScore = land.risks[parcel.id]?.hazards[hazard]?.score;
        const boundaryColor = land.selected.has(parcel.id) ? 0xffe077 : colorForParcel(parcel);
        const color = hazard !== "land_use" && riskScore != null ? (riskScore >= 65 ? 0xff6577 : riskScore >= 35 ? 0xffca6b : 0x42d98f) : boundaryColor;
        if (record.color !== color) { fill.material.color.set(color); record.color = color; }
        if (record.boundaryColor !== boundaryColor) { line.material.color.set(boundaryColor); record.boundaryColor = boundaryColor; }
        if (hazard !== "land_use") fill.material.opacity = .65;
        if (state.legendClass) {
          const matches = sceneVisuals.classification(parcel) === state.legendClass;
          fill.material.opacity *= matches ? 1.5 : .1;
          line.material.opacity = matches ? 1 : .12;
        } else line.material.opacity = .86;
      });
      surveyFrames.forEach(({ scanner, parcel, building, phase }) => {
        const expanded = motion.exploded && state.selectedParcel?.id === parcel.id;
        const height = building.height + (expanded ? (building.floors.length - 1) * 1.35 : 0);
        const cycle = (seconds * .16 + phase) % 1;
        scanner.visible = activeMotion && motion.scan && assembly > 2.4 && !isolation && (!motion.exploded || expanded);
        scanner.position.y = building.position.y + .15 + cycle * height;
        scanner.material.opacity = Math.sin(cycle * Math.PI) * .7;
      });
      const parcel = state.parcelById.get(hoveredFloor?.userData.parcelId || hoveredParcel?.userData.parcelId) || state.selectedParcel;
      selectionFrame.visible = !!parcel;
      if (parcel) {
        const snap = selectionPosition.parcelId === null;
        selectionPosition.parcelId = parcel.id;
        selectionFrame.position.lerp(sceneScratch.set(parcel.position.x, .18, parcel.position.z), snap ? 1 : blend);
        selectionFrame.scale.lerp(selectionScale.set(parcel.size.w + .5, 1, parcel.size.d + .5), snap ? 1 : blend);
        selectionFrame.material.opacity = .65 + Math.sin(seconds * 2.2) * .16;
      }
    }

    function animate3D(now = performance.now()) {
      sceneFrame = null;
      const elapsed = Math.max(0, now - lastFrameTime);
      lastFrameTime = now;
      if (document.hidden || !viewportVisible) return;
      if (pendingPointer) {
        const event = pendingPointer;
        pendingPointer = null;
        onPointerMove(event);
      }
      const delta = Math.min(elapsed / 1000, .15);
      const activeMotion = isSceneMotionActive();
      if (!activeMotion && !cameraTween) {
        renderStillFrame();
        return;
      }
      if (activeMotion) motion.time += delta * motion.speed;
      updateCameraTween(now);
      if (activeMotion) animateConflict(motion.time * 1000);
      animateSpatialLayers(delta);
      controls.autoRotate = activeMotion && motion.orbit && state.activeView === "3d" && !cameraTween && !hoveredFloor;
      controls.autoRotateSpeed = .55 * motion.speed * delta * 60;
      controls.update();

      fpsFrames++;
      fpsAccum += elapsed;
      if (fpsAccum >= 600) {
        const fps = Math.round((fpsFrames * 1000) / fpsAccum);
        $("fpsCounter").textContent = `FPS ${fps}`;
        fpsFrames = 0;
        fpsAccum = 0;
      }

      renderer.render(scene, activeCamera);
      if (isSceneMotionActive() || cameraTween) requestSceneFrame();
    }

    function bindLayerToggles() {
      document.querySelectorAll(".mini-switch").forEach(btn => {
        btn.addEventListener("click", () => {
          if (!state.sceneReady) return;
          btn.classList.toggle("on");
          const visible = btn.classList.contains("on");
          btn.setAttribute("aria-pressed", String(visible));
          const layer = btn.dataset.layer;
          if (layer === "terrain") terrainGroup.visible = visible;
          if (layer === "parcels") { parcelGroup.visible = visible; clearHover(); }
          if (layer === "buildings") {
            buildingGroup.visible = visible;
            clearHover();
          }
          if (layer === "conflict") {
            riskGroup.visible = visible;
            conflictGroup.visible = visible;
          }
          if (layer === "pipelines") pipelineGroup.visible = visible;
          if (layer === "underground") undergroundGroup.visible = visible;
          renderStillFrame();
        });
      });
      $("groundCutaway")?.addEventListener("change", updateSceneTheme);
      document.querySelectorAll(".infra-category").forEach(input => input.addEventListener("change", () => {
        const category = input.dataset.category;
        [...pipelineGroup.children, ...undergroundGroup.children].forEach(obj => { if (obj.userData.category === category) obj.visible = input.checked; });
        renderStillFrame();
      }));
    }

    function drawPropertyQr(parcel = state.selectedParcel) {
      const canvas = $("propertyQr"); if (!canvas || !parcel) return;
      const ctx = canvas.getContext("2d"), n = 29, cell = 5, seed = `${parcel.parcel_ulpin}|/property/${parcel.id}`;
      ctx.fillStyle="#fff"; ctx.fillRect(0,0,canvas.width,canvas.height); ctx.fillStyle="#111";
      const bit = (x,y) => { let v=0; for (let i=0;i<seed.length;i++) v=(v*31+seed.charCodeAt(i)+x*17+y*13)%9973; return v%2===0; };
      const finder = (ox,oy) => { for(let y=0;y<7;y++) for(let x=0;x<7;x++) if(x===0||y===0||x===6||y===6||(x>1&&x<5&&y>1&&y<5)) ctx.fillRect((ox+x)*cell+8,(oy+y)*cell+8,cell,cell); };
      for(let y=0;y<n;y++) for(let x=0;x<n;x++) if(bit(x,y)) ctx.fillRect(x*cell+8,y*cell+8,cell,cell); finder(0,0); finder(n-7,0); finder(0,n-7);
      $("propertyQrLabel").textContent = `${parcel.parcel_display_ulpin} / public record`;
    }

    $("addPipelineBtn")?.addEventListener("click", () => {
      const p = state.selectedParcel; if (!p || !pipelineGroup) return;
      const x=p.position.x, z=p.position.z, id=`PIP-${String(pipelineGroup.children.length+1).padStart(3,"0")}`;
      const metadata={assetId:id,infrastructureType:"Custom pipeline",category:"water",depth:2.1,dimensions:"300 mm",material:"HDPE",status:"Planned",owner:"Survey Department",startCoordinates:`${(x-4).toFixed(2)}, ${(z-8).toFixed(2)}`,endCoordinates:`${(x+8).toFixed(2)}, ${(z-8).toFixed(2)}`};
      const curve=new THREE.LineCurve3(new THREE.Vector3(x-4,-2.1,z-8),new THREE.Vector3(x+8,-2.1,z-8));
      const tube=new THREE.Mesh(new THREE.TubeGeometry(curve,16,.22,10,false),sceneVisuals.surface({color:0x35c9f4,emissive:0x35c9f4,emissiveIntensity:.2})); tube.userData={kind:"underground-asset",...metadata}; pipelineGroup.add(tube); renderStillFrame();
    });

    async function bootstrap() {
      applyTheme();
      syncMotionControls();
      lucide.createIcons();
      resizeBackground();
      updateClock();
      setInterval(updateClock, 1000);

      try {
        const data = await api("/api/parcels");
        state.parcels = data.items;
        state.parcelById = new Map(data.items.map(p => [p.id, p]));
        data.items.forEach(p => {
          const records = new Map(p.floors.map(f => [f.id, f]));
          p.buildings.forEach(b => { b.floors = b.floors.map(f => {
            if (!records.has(f.id)) { records.set(f.id, f); p.floors.push(f); }
            return records.get(f.id);
          }); });
        });
        state.sceneParcels = data.items.filter(p => p.area_id === state.activeAreaId);
        state.filteredParcels = [...data.items];
        try {
          const preview = await api("/api/overlap/preview");
          state.preflightOverlaps = preview.items || [];
        } catch (previewErr) {
          state.preflightOverlaps = [];
          console.warn("Overlap preview unavailable:", previewErr);
        }
        populateFilters();
        renderParcelResults(state.filteredParcels);

        if (state.parcels.length) {
          state.selectedParcel = state.parcels[0];
          state.selectedFloor = state.selectedParcel.floors[0];
          renderSelectedParcel();
          renderFloorList();
          renderFloorMetrics();
          renderVerificationTarget();
          renderAllInsights();
          // Show soil data immediately; weather values fill in once loadSiteWeather resolves
          updateParcelWeatherPanel(state.parcels[0]);
        }

        // Weather is loaded after the parcel register so every parcel can be scored.
        await loadSiteWeather();
        await initLandIntelligence();

        await ensureThreeDependencies();
        assertWebGLAvailable();
        init3D();
        logConsole("Spatial engine initialized.", "good");
        logConsole(`Indexed ${state.parcels.length} parcels / ${state.parcels.reduce((n,p) => n + p.floors.length, 0)} vertical units.`);
        logConsole("Schematic regional clusters; scene distances are not geographic distances.", "dim");
      } catch (err) {
        console.error("ULPIN application startup failed:", err);
        showViewportError(err);
        toast(`Startup error: ${err.message}`, "danger");
        if (!state.parcels.length) {
          $("parcelResults").innerHTML = `<div class="warning-card show"><div class="warning-title">Failed to load data</div><div class="warning-body">${escapeHtml(err.message)}</div></div>`;
        }
      }

      refreshAudit();
    }

      document.querySelectorAll(".tab-btn").forEach(btn => btn.addEventListener("click", () => {
        switchTab(btn.dataset.tab);
      }));
    document.querySelectorAll("[data-jump-tab]").forEach(btn => btn.addEventListener("click", () => switchTab(btn.dataset.jumpTab)));
    $("faqBtn").addEventListener("click", () => switchTab("faq"));
    $("themeToggle").addEventListener("click", () => {
      state.theme = state.theme === "dark" ? "light" : "dark";
      applyTheme();
    });

    $("searchBtn").addEventListener("click", runSearch);
    $("clearSearchBtn").addEventListener("click", clearSearch);
    $("exportCsvBtn").addEventListener("click", () => {
      const rows = state.filteredParcels.map(p => ({
        parcel: p.id,
        display_ulpin: p.parcel_display_ulpin,
        state: p.state,
        district: p.district,
        survey_no: p.survey_no,
        type: p.land_use,
        floors: p.floors.length,
        area_sqft: p.registered_area_sqft,
        status: p.status
      }));
      const header = Object.keys(rows[0] || { parcel: "" });
      const csv = [header.join(","), ...rows.map(r => header.map(k => `"${String(r[k] ?? "").replaceAll('"', '""')}"`).join(","))].join("\n");
      downloadFile("ulpin_registry_filtered.csv", csv, "text/csv");
    });
    $("exportJsonBtn").addEventListener("click", () => {
      const rows = state.filteredParcels;
      downloadFile("ulpin_registry_filtered.json", JSON.stringify(rows, null, 2), "application/json");
    });
    $("surveyFilter").addEventListener("keydown", e => { if (e.key === "Enter") runSearch(); });
    $("ulpinFilter").addEventListener("keydown", e => { if (e.key === "Enter") runSearch(); });

    $("overlapBtn").addEventListener("click", executeOverlapCheck);
    $("flagBtn")?.addEventListener("click", () => officerAction("flag_conflict"));
    $("resurveyBtn")?.addEventListener("click", () => officerAction("request_resurvey"));
    $("approveBtn")?.addEventListener("click", () => officerAction("approve"));
    $("refreshAuditBtn")?.addEventListener("click", refreshAudit);
    $("viewQrBtn")?.addEventListener("click", () => { const p = state.selectedParcel, c = $("propertyQr"); if (!p || !c) return; const w = window.open("", "ulpin-qr", "width=420,height=520"); w.document.write(`<title>ULPIN QR ${p.id}</title><h1>${p.parcel_display_ulpin}</h1><img src="${c.toDataURL("image/png")}" /><p>Public property reference</p>`); w.document.close(); });
    $("downloadQrBtn")?.addEventListener("click", () => { const p = state.selectedParcel, c = $("propertyQr"); if (!p || !c) return; const a = document.createElement("a"); a.href=c.toDataURL("image/png"); a.download=`${p.parcel_display_ulpin}-qr.png`; a.click(); });
    $("printQrBtn")?.addEventListener("click", () => { const c=$("propertyQr"); if (!c) return; const w=window.open("", "print-qr", "width=420,height=520"); w.document.write(`<title>ULPIN QR</title><img style="width:300px" src="${c.toDataURL("image/png")}" /><script>window.print()<\/script>`); w.document.close(); });

    $("closeModalBtn")?.addEventListener("click", closePropertyCard);
    $("propertyModal")?.addEventListener("click", e => { if (e.target === $("propertyModal")) closePropertyCard(); });
    $("printCardBtn")?.addEventListener("click", () => window.print());
    $("logoutBtn").addEventListener("click", async () => {
      try { await api("/api/auth/logout", {method: "POST"}); location.replace("/login"); }
      catch (err) { toast(err.message, "danger"); }
    });
    async function refreshAdmin() {
      if (!$("adminStats")) return;
      try {
        const data = await api("/api/admin/dashboard");
        $("adminStats").innerHTML = kpi("Pending units", data.pending_units, "Verification queue") + kpi("Audit events", data.audit_events, "Recorded actions");
        $("adminUsers").innerHTML = data.users.map(user => `<div class="attention-item"><strong>${escapeHtml(user.username)}</strong><span>${escapeHtml(user.role)}</span></div>`).join("");
      } catch (err) { toast(err.message, "danger"); }
    }
    $("adminRefresh")?.addEventListener("click", refreshAdmin);
    $("accountForm")?.addEventListener("submit", async event => {
      event.preventDefault();
      const form = event.currentTarget, button = form.querySelector('button');
      button.disabled = true;
      try {
        await api("/api/admin/users", {method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form)))});
        form.reset(); $("accountStatus").textContent = "Account created.";
        await refreshAdmin();
      } catch (err) { $("accountStatus").textContent = err.message; }
      finally { button.disabled = false; }
    });
    window.addEventListener("keydown", e => { if (e.key === "Escape") closePropertyCard(); });

    $("view3D").addEventListener("click", () => set3DView(true));
    $("view2D").addEventListener("click", set2DView);
    $("resetView").addEventListener("click", () => resetCamera());
    $("explodeView").addEventListener("click", toggleExplosion);
    $("orbitToggle").addEventListener("click", () => setOrbit(!motion.orbit));
    $("scanToggle").addEventListener("click", () => {
      motion.scan = !motion.scan;
      syncMotionControls();
    });
    $("motionToggle").addEventListener("click", () => {
      motion.enabled = !motion.enabled;
      if (!motion.enabled) {
        assemblyStart = motion.time - 4;
        if (cameraTween) tweenCamera(cameraTween.camera, cameraTween.targetPosition, cameraTween.targetLookAt, 0);
      }
      syncMotionControls();
      renderStillFrame();
    });
    $("motionSpeed").addEventListener("input", event => {
      motion.speed = Number(event.target.value);
      $("motionSpeedValue").value = `${motion.speed.toFixed(2)}x`;
    });
    $("replayScene").addEventListener("click", replayAssembly);
    $("viewBlueprintAction")?.addEventListener("click", openBlueprintForSelection);
    $("blueprintClose")?.addEventListener("click", closeBlueprintView);
    $("blueprintReset")?.addEventListener("click", resetBlueprintView);
    $("blueprintMeasure")?.addEventListener("click", () => toast("Use zoom and room hover for approximate blueprint dimensions.", "info"));
    $("blueprintNote")?.addEventListener("click", () => toast("Notes are not persisted in this demo build.", "info"));
    $("blueprintExport")?.addEventListener("click", () => {
      const canvas = $("blueprintCanvas");
      if (!canvas || !state.blueprint.plan) return;
      const link = document.createElement("a");
      link.href = canvas.toDataURL("image/png");
      link.download = `${state.blueprint.plan.parcel.id}-${state.blueprint.plan.floor.id}-blueprint.png`;
      document.body.appendChild(link); link.click(); link.remove();
    });
    $("blueprintCanvas")?.addEventListener("pointerdown", event => {
      if (!state.blueprint.open) return;
      state.blueprint.dragging = true;
      state.blueprint.moved = false;
      state.blueprint.lastX = event.clientX;
      state.blueprint.lastY = event.clientY;
      $("blueprintCanvas").classList.add("dragging");
      $("blueprintCanvas").setPointerCapture?.(event.pointerId);
    });
    $("blueprintCanvas")?.addEventListener("pointermove", event => {
      if (!state.blueprint.open) return;
      if (state.blueprint.dragging) {
        if (Math.hypot(event.clientX - state.blueprint.lastX, event.clientY - state.blueprint.lastY) > 1) state.blueprint.moved = true;
        state.blueprint.panX += event.clientX - state.blueprint.lastX;
        state.blueprint.panY += event.clientY - state.blueprint.lastY;
        state.blueprint.lastX = event.clientX;
        state.blueprint.lastY = event.clientY;
        drawBlueprint();
        return;
      }
      const rect = $("blueprintCanvas").getBoundingClientRect();
      const room = roomAtBlueprintPoint(screenToBlueprint(event.clientX - rect.left, event.clientY - rect.top));
      if (room !== state.blueprint.hoverRoom) {
        state.blueprint.hoverRoom = room;
        drawBlueprint();
      }
      const hover = $("blueprintHover");
      if (room) {
        hover.classList.add("show");
        hover.style.left = `${Math.min(event.clientX - rect.left + 14, rect.width - 190)}px`;
        hover.style.top = `${Math.min(event.clientY - rect.top + 14, rect.height - 62)}px`;
        hover.innerHTML = `<strong>${escapeHtml(room.name)}</strong><br>${room.area_sqft ? `Approx. ${room.area_sqft.toLocaleString()} sq ft` : escapeHtml(room.type)}`;
      } else hover.classList.remove("show");
    });
    $("blueprintCanvas")?.addEventListener("pointerup", event => {
      if (!state.blueprint.open) return;
      const wasDragging = state.blueprint.moved;
      state.blueprint.dragging = false;
      state.blueprint.moved = false;
      $("blueprintCanvas").classList.remove("dragging");
      try { $("blueprintCanvas").releasePointerCapture?.(event.pointerId); } catch (_) {}
      if (!wasDragging && state.blueprint.hoverRoom) {
        state.blueprint.selectedRoom = state.blueprint.hoverRoom;
        updateBlueprintPanel(state.blueprint.selectedRoom);
        drawBlueprint();
      }
    });
    $("blueprintCanvas")?.addEventListener("pointerleave", () => {
      state.blueprint.dragging = false;
      state.blueprint.hoverRoom = null;
      $("blueprintCanvas").classList.remove("dragging");
      $("blueprintHover")?.classList.remove("show");
      drawBlueprint();
    });
    $("blueprintCanvas")?.addEventListener("wheel", event => {
      if (!state.blueprint.open) return;
      event.preventDefault();
      const rect = $("blueprintCanvas").getBoundingClientRect();
      const before = screenToBlueprint(event.clientX - rect.left, event.clientY - rect.top);
      const nextScale = clamp(state.blueprint.scale * (event.deltaY < 0 ? 1.1 : .9), .35, 3.4);
      state.blueprint.scale = nextScale;
      state.blueprint.panX = event.clientX - rect.left - before.x * nextScale;
      state.blueprint.panY = event.clientY - rect.top - before.y * nextScale;
      drawBlueprint();
    }, {passive: false});
    document.addEventListener("click", event => {
      if (!$("floorContextMenu")?.contains(event.target)) hideFloorContextMenu();
    });
    reducedMotion.addEventListener("change", event => {
      motion.enabled = !event.matches;
      motion.orbit = !event.matches;
      setViewportActive(false);
      assemblyStart = motion.time - 4;
      syncMotionControls();
      renderStillFrame();
    });

    window.addEventListener("resize", () => {
      resizeBackground();
      if (!window.matchMedia("(max-width: 1180px)").matches) {
        const shouldRestoreCollapsed = splitLayout.collapsed;
        applyWorkspaceSplit(splitLayout.currentPct, { animate: false, resizeScene: false });
        setListCollapsed(shouldRestoreCollapsed, false);
      }
      scheduleResize3D();
      if (state.blueprint.open) resetBlueprintView();
    });
    window.addEventListener("keydown", event => {
      if (event.key === "Escape" && state.blueprint.open) closeBlueprintView();
    });

    bindWorkspaceSplitter();
    bindLayerToggles();
    $("legendClasses").addEventListener("click", event => {
      const button = event.target.closest("[data-legend-class]");
      if (!button || button.disabled) return;
      state.legendClass = state.legendClass === button.dataset.legendClass ? null : button.dataset.legendClass;
      $("legendClasses").querySelectorAll("button").forEach(item => item.setAttribute("aria-pressed", String(item.dataset.legendClass === state.legendClass)));
      renderStillFrame();
    });
    const compactViewport = window.matchMedia("(max-width: 640px)");
    $("sceneLayers").open = !compactViewport.matches;
    $("spatialLegend").open = !compactViewport.matches;
    compactViewport.addEventListener("change", event => {
      $("sceneLayers").open = !event.matches;
      $("spatialLegend").open = !event.matches;
    });
    bootstrap();
    if (isAdmin) { switchTab("admin"); refreshAdmin(); }
