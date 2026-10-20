(() => {
  const state = {
    dataset: "pickup",
    city: "sh",
    cityName: "Shanghai",
    variable: "courier_id",
    value: null,
    panel: "records",
    options: [],
    records: [],
    page: 1,
    panelIndex: 0,
    request: 0,
    cityTotalRows: 0,
    cityFilteredRows: 0,
  };
  const panels = ["records", "groups", "gps", "couriers"];
  const panelNames = ["Courses sélectionnées", "Répartition par valeur", "Qualité GPS", "Variabilité coursiers"];
  const panelIds = { records: "recordsPanel", groups: "groupsPanel", gps: "gpsPanel", couriers: "couriersPanel" };
  const cityNames = { sh: "Shanghai", hz: "Hangzhou", cq: "Chongqing", jl: "Jilin", yt: "Yantai" };
  const variableNames = { region_id: "région", courier_id: "coursier", aoi_id: "zone" };
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  let nextOSRMRequestAt = 0;
  const routeMaps = new Map();

  function setTheme(theme) {
    const dark = theme === "dark";
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    const toggle = $("#themeToggle");
    toggle.setAttribute("aria-pressed", String(dark));
    toggle.setAttribute("aria-label", dark ? "Activer le mode clair" : "Activer le mode nuit");
    toggle.querySelector(".theme-icon").textContent = dark ? "☀" : "☾";
    toggle.querySelector(".theme-label").textContent = dark ? "Mode clair" : "Mode nuit";
  }

  const savedTheme = localStorage.getItem("lade-dashboard-theme");
  setTheme(savedTheme || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  $("#themeToggle").addEventListener("click", () => {
    const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    localStorage.setItem("lade-dashboard-theme", theme);
    setTheme(theme);
  });

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  }
  function number(value) { return new Intl.NumberFormat("fr-FR").format(Number(value || 0)); }
  function minutes(value) { return value == null ? "—" : `${Number(value).toLocaleString("fr-FR", { maximumFractionDigits: 2 })} min`; }
  function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    if (!sorted.length) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }
  function getDates() { return { start: $("#dateStart").value, end: $("#dateEnd").value }; }
  function query(extra = {}) {
    const params = new URLSearchParams({ dataset: state.dataset, city: state.city, variable: state.variable, ...getDates(), ...extra });
    if (state.value != null) params.set("value", state.value);
    return params;
  }
  async function getJSON(url, options) {
    const response = await fetch(url, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Erreur HTTP ${response.status}`);
    return data;
  }
  function showError(message) {
    $("#errorState").textContent = message;
    $("#errorState").classList.remove("hidden");
  }
  function clearError() { $("#errorState").classList.add("hidden"); }
  function setLoading(loading) {
    $("#loadingState").classList.toggle("hidden", !loading);
    $$(".analysis-panel").forEach((element) => element.classList.toggle("hidden", loading || element.id !== panelIds[state.panel]));
  }
  function syncHeader() {
    $("#breadcrumbDataset").textContent = state.dataset === "pickup" ? "Pickup" : "Delivery";
    $("#breadcrumbCity").textContent = state.cityName;
    $("#mainTitle").textContent = state.dataset === "pickup" ? "Analyse des collectes" : "Analyse des livraisons";
    $("#rangeLabel").textContent = `${getDates().start || "…"} → ${getDates().end || "…"}`;
    $("#panelSelect").value = state.panel;
    state.panelIndex = panels.indexOf(state.panel);
    $("#panelPosition").textContent = `${String(state.panelIndex + 1).padStart(2, "0")} / 04`;
    $$(".analysis-panel").forEach((element) => element.classList.toggle("hidden", element.id !== panelIds[state.panel]));
  }
  function setActiveButtons() {
    $$(".dataset-tab").forEach((button) => {
      const active = button.dataset.dataset === state.dataset;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    $$(".city-button").forEach((button) => button.classList.toggle("active", button.dataset.city === state.city));
    $$(".variable-tab").forEach((button) => button.classList.toggle("active", button.dataset.variable === state.variable));
  }
  function renderOptions() {
    const search = $("#valueSearch").value.trim().toLowerCase();
    const values = state.options.filter((option) => String(option.value).toLowerCase().includes(search));
    $("#valueCount").textContent = number(state.options.length);
    const list = $("#valueList");
    if (!values.length) {
      list.innerHTML = '<div class="empty-state">Aucune valeur trouvée pour cette période.</div>';
      return;
    }
    const fragment = document.createDocumentFragment();
    values.forEach((option) => {
      const button = document.createElement("button");
      button.className = `value-option${String(option.value) === String(state.value) ? " active" : ""}`;
      button.type = "button";
      button.dataset.value = option.value;
      const label = document.createElement("span");
      label.textContent = option.value;
      const count = document.createElement("span");
      count.className = "option-count";
      count.textContent = number(option.count);
      button.append(label, count);
      button.addEventListener("click", () => {
        state.value = option.value;
        state.page = 1;
        renderOptions();
        loadPanel();
      });
      fragment.append(button);
    });
    list.replaceChildren(fragment);
  }

  async function loadOptions(keepValue = true) {
    const requestId = ++state.request;
    setLoading(true);
    clearError();
    try {
      const data = await getJSON(`/api/options/?${query({}).toString()}`);
      if (requestId !== state.request) return;
      const previous = state.value;
      state.options = data.options || [];
      state.cityTotalRows = Number(data.city_total_rows || 0);
      state.cityFilteredRows = Number(data.total_rows || 0);
      $("#cityTotalRows").textContent = number(data.city_total_rows);
      $("#cityRowCount").textContent = number(data.total_rows);
      $("#metricCourierMissing").textContent = `${Number(data.courier_missing_percent || 0).toLocaleString("fr-FR", { maximumFractionDigits: 2 })}%`;
      $("#metricCourierMissingFoot").textContent = `${number(data.courier_missing_rows)} identifiant(s) manquant(s) sur ${number(data.total_rows)} tâche(s)`;
      state.page = 1;
      const exists = state.options.some((item) => String(item.value) === String(previous));
      state.value = keepValue && exists ? previous : (state.options[0]?.value ?? null);
      renderOptions();
      syncHeader();
      setLoading(false);
      if (state.options.length) await loadPanel();
      else showError("Aucune tâche ne correspond à ces filtres. Modifiez la période ou la ville.");
    } catch (error) {
      if (requestId !== state.request) return;
      setLoading(false);
      showError(error.message);
    }
  }

  async function loadPanel() {
    const requestId = ++state.request;
    clearError();
    syncHeader();
    setLoading(true);
    try {
      if (state.panel === "groups") {
        renderGroups();
      } else {
        const params = query({ panel: state.panel, page: state.page });
        const data = await getJSON(`/api/analysis/?${params.toString()}`);
        if (requestId !== state.request) return;
        if (state.panel === "records") renderRecords(data);
        if (state.panel === "gps") renderGps(data);
        if (state.panel === "couriers") renderCouriers(data.couriers || []);
      }
      setLoading(false);
    } catch (error) {
      if (requestId !== state.request) return;
      setLoading(false);
      showError(error.message);
    }
  }

  function svgBars(container, entries, options = {}) {
    if (!entries.length) {
      container.innerHTML = '<div class="empty-state">Aucune donnée à représenter.</div>';
      return;
    }
    const width = 620;
    const rowHeight = options.rowHeight || 25;
    const left = options.left || 112;
    const right = 42;
    const top = 8;
    const height = Math.max(170, top + entries.length * rowHeight + 14);
    const max = Math.max(1, ...entries.map((entry) => Number(entry.value) || 0));
    const chartWidth = width - left - right;
    const rows = entries.map((entry, i) => {
      const y = top + i * rowHeight;
      const barWidth = Math.max(1, chartWidth * (Number(entry.value) || 0) / max);
      const label = String(entry.label).length > 17 ? `${String(entry.label).slice(0, 16)}…` : String(entry.label);
      const valueText = entry.format === "decimal" ? Number(entry.value).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) : number(entry.value);
      return `<text class="chart-label" x="${left - 8}" y="${y + 13}" text-anchor="end">${esc(label)}</text><rect class="${options.alt ? "chart-bar alt" : "chart-bar"}" x="${left}" y="${y}" width="${barWidth}" height="14" rx="4"><title>${esc(entry.label)} : ${esc(valueText)}</title></rect><text class="chart-value" x="${Math.min(width - 3, left + barWidth + 6)}" y="${y + 11}">${esc(valueText)}</text>`;
    }).join("");
    container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Diagramme à barres">${rows}</svg>`;
  }

  function pieChart(container, legend, counts) {
    const zero = Number(counts["0"] || 0);
    const one = Number(counts["1"] || 0);
    const total = zero + one;
    if (!total) {
      container.innerHTML = '<div class="empty-state">Aucun pickup avec les deux heures nécessaires au calcul.</div>';
      legend.innerHTML = "";
      return;
    }
    const percent0 = zero / total * 100;
    const percent1 = one / total * 100;
    const circumference = 2 * Math.PI * 48;
    const dash0 = circumference * zero / total;
    const dash1 = circumference * one / total;
    container.innerHTML = `<div class="pie-wrap"><svg class="pie-svg" viewBox="0 0 140 140" role="img" aria-label="Respect du créneau : 0 avant le créneau ${percent0.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} %, 1 à partir du créneau ${percent1.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} %"><circle class="pie-track" cx="70" cy="70" r="48"></circle><circle class="pie-segment status-zero" cx="70" cy="70" r="48" stroke-dasharray="${dash0} ${circumference}" transform="rotate(-90 70 70)" tabindex="0"><title>0 · avant le début du créneau : ${percent0.toLocaleString("fr-FR", { maximumFractionDigits: 1 })}% (${number(zero)} tâches)</title></circle><circle class="pie-segment status-one" cx="70" cy="70" r="48" stroke-dasharray="${dash1} ${circumference}" stroke-dashoffset="-${dash0}" transform="rotate(-90 70 70)" tabindex="0"><title>1 · à partir du début du créneau : ${percent1.toLocaleString("fr-FR", { maximumFractionDigits: 1 })}% (${number(one)} tâches)</title></circle><text class="pie-total" x="70" y="66" text-anchor="middle">${number(total)}</text><text class="pie-caption" x="70" y="84" text-anchor="middle">pickups classés</text></svg></div>`;
    legend.innerHTML = `<span><i class="legend-dot" style="background:#6aa99b"></i>0 · avant (${percent0.toLocaleString("fr-FR", { maximumFractionDigits: 1 })}% · ${number(zero)})</span><span><i class="legend-dot" style="background:#dfa866"></i>1 · à partir de l’heure (${percent1.toLocaleString("fr-FR", { maximumFractionDigits: 1 })}% · ${number(one)})</span>`;
  }

  function renderRecords(data) {
    routeMaps.forEach((map) => map.remove());
    routeMaps.clear();
    state.records = data.records || [];
    $("#metricTasks").textContent = number(data.total);
    $("#metricMedian").textContent = minutes(data.duration?.median);
    $("#metricIqr").textContent = data.duration?.q25 == null ? "—" : `${Number(data.duration.q25).toLocaleString("fr-FR")} – ${Number(data.duration.q75).toLocaleString("fr-FR")} min`;
    $("#metricIqrFoot").textContent = data.duration?.q25 == null
      ? "Pas assez de durées calculables pour établir Q1 et Q3."
      : `50 % des tâches centrales ; largeur Q3 − Q1 = ${Number(data.duration.q75 - data.duration.q25).toLocaleString("fr-FR")} min`;
    const classified = Number(data.status_counts?.["0"] || 0) + Number(data.status_counts?.["1"] || 0);
    const onOrAfter = Number(data.status_counts?.["1"] || 0);
    $("#metricStatus").textContent = state.dataset === "pickup" && classified ? `${(onOrAfter / classified * 100).toLocaleString("fr-FR", { maximumFractionDigits: 1 })}%` : "—";
    $("#selectedGroupLabel").textContent = `${variableNames[state.variable] || state.variable} ${data.value} · ${state.cityName}`;
    $("#pickupRule").classList.toggle("hidden", state.dataset !== "pickup");
    $("#totalPickup").textContent = state.dataset === "pickup" ? `Total des pickups classés : ${number(classified)} / ${number(data.total)}` : "";
    if (state.dataset === "pickup") pieChart($("#statusChart"), $("#statusLegend"), data.status_counts || {});
    else {
      svgBars($("#statusChart"), [{ label: "Durée médiane (min)", value: data.duration?.median || 0, format: "decimal" }]);
      $("#statusLegend").innerHTML = '<span><i class="legend-dot" style="background:#5b88a4"></i>Durée acceptation → livraison</span>';
    }
    const topGroups = [...state.options].sort((a, b) => b.count - a.count).slice(0, 8).map((item) => ({ label: item.value, value: item.count }));
    svgBars($("#groupChart"), topGroups, { rowHeight: 22, left: 102 });
    const eventLabel = state.dataset === "pickup" ? "pickup_time" : "delivery_time";
    const headers = ["Order ID", "Accept time", eventLabel, "Durée (min)"];
    if (state.dataset === "pickup") headers.push("Règle 0 / 1");
    headers.push("GPS / OpenStreetMap");
    $("#taskHead").innerHTML = `<tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>`;
    $("#taskBody").innerHTML = state.records.map((record, index) => {
      const status = record.status == null ? "—" : `<span class="badge${record.status === 1 ? " orange" : ""}">${record.status}</span>`;
      const osmButton = record.origin_lat != null && record.origin_lng != null && record.destination_lat != null && record.destination_lng != null && record.duration_min != null
        ? `<button type="button" class="route-button" data-route-index="${index}">Comparer OSM</button><div class="route-result" id="routeResult${index}"></div><div class="route-map hidden" id="routeMap${index}" aria-label="Carte de l’itinéraire OSRM"></div>`
        : '<span class="route-result">Coordonnées manquantes</span>';
      return `<tr><td>${esc(record.order_id || "—")}</td><td>${esc(record.accept_time || "—")}</td><td>${esc(record.event_time || "—")}</td><td>${minutes(record.duration_min)}</td>${state.dataset === "pickup" ? `<td>${status}</td>` : ""}<td>${osmButton}</td></tr>`;
    }).join("") || '<tr><td colspan="6">Aucune course pour cette sélection.</td></tr>';
    $("#recordsCaption").textContent = `Affichage de ${number(state.records.length)} tâche(s) sur ${number(data.total)} pour cette sélection.`;
    $("#pageCaption").textContent = `Page ${number(data.page)} / ${number(data.pages)}`;
    $("#previousPage").disabled = data.page <= 1;
    $("#nextPage").disabled = data.page >= data.pages;
    $$("[data-route-index]").forEach((button) => button.addEventListener("click", () => compareOsm(Number(button.dataset.routeIndex), button)));
  }

  function renderGroups() {
    const sorted = [...state.options].sort((a, b) => b.count - a.count);
    const total = sorted.reduce((sum, item) => sum + Number(item.count), 0);
    $("#groupCountMetric").textContent = number(sorted.length);
    $("#groupTotalMetric").textContent = number(total);
    $$(".variable-title").forEach((el) => { el.textContent = variableNames[state.variable] || state.variable; });
    svgBars($("#allGroupsChart"), sorted.slice(0, 25).map((item) => ({ label: item.value, value: item.count })), { rowHeight: 22, left: 120 });
    $("#groupsBody").innerHTML = sorted.map((item) => `<tr><td>${esc(item.value)}</td><td>${number(item.count)}</td><td>${total ? (Number(item.count) / total * 100).toLocaleString("fr-FR", { maximumFractionDigits: 2 }) : "0"}%</td></tr>`).join("");
  }

  function renderGps(data) {
    $("#gpsTaskCount").textContent = number(data.total);
    $("#gpsMedian").textContent = data.distance?.median_km == null ? "—" : `${Number(data.distance.median_km).toLocaleString("fr-FR")} km`;
    $("#gpsP90").textContent = data.distance?.p90_km == null ? "—" : `${Number(data.distance.p90_km).toLocaleString("fr-FR")} km`;
    const averageMissing = (data.missing || []).length ? data.missing.reduce((sum, item) => sum + item.percent, 0) / data.missing.length : 0;
    $("#gpsMissing").textContent = `${averageMissing.toLocaleString("fr-FR", { maximumFractionDigits: 1 })}%`;
    $("#gpsBody").innerHTML = (data.missing || []).map((item) => `<tr><td><code>${esc(item.column)}</code></td><td>${number(item.missing)}</td><td>${Number(item.percent).toLocaleString("fr-FR", { maximumFractionDigits: 2 })}%</td></tr>`).join("");
    svgBars($("#gpsMissingChart"), (data.missing || []).map((item) => ({ label: item.column.replaceAll("_", " "), value: item.percent, format: "decimal" })), { rowHeight: 25, left: 155, alt: true });
    svgBars($("#distanceChart"), (data.distance_bins || []).map((item) => ({ label: `${item.label} km`, value: item.count })), { rowHeight: 18, left: 92 });
  }

  function renderCouriers(couriers) {
    $("#courierCountMetric").textContent = number(couriers.length);
    const medians = couriers.map((item) => item.median_min).filter(Number.isFinite);
    $("#courierMedianMetric").textContent = minutes(median(medians));
    const top = couriers.slice(0, 20);
    svgBars($("#courierChart"), top.map((item) => ({ label: item.courier_id, value: item.tasks })), { rowHeight: 21, left: 100 });
    svgBars($("#courierDurationChart"), top.map((item) => ({ label: item.courier_id, value: item.median_min, format: "decimal" })), { rowHeight: 21, left: 100, alt: true });
    $("#courierBody").innerHTML = couriers.map((item) => `<tr><td>${esc(state.cityName)}</td><td>${esc(item.courier_id)}</td><td>${number(item.tasks)}</td><td>${(Number(item.total_min) / 60).toLocaleString("fr-FR", { maximumFractionDigits: 2 })}</td><td>${Number(item.median_min).toLocaleString("fr-FR", { maximumFractionDigits: 2 })}</td><td>${Number(item.q25_min).toLocaleString("fr-FR", { maximumFractionDigits: 2 })}</td><td>${Number(item.q75_min).toLocaleString("fr-FR", { maximumFractionDigits: 2 })}</td></tr>`).join("") || '<tr><td colspan="7">Aucune tâche complète pour cette période.</td></tr>';
  }

  async function compareOsm(index, button) {
    const record = state.records[index];
    const target = $(`#routeResult${index}`);
    routeMaps.get(index)?.remove();
    routeMaps.delete(index);
    $(`#routeMap${index}`)?.classList.add("hidden");
    button.disabled = true;
    button.textContent = "Calcul OSRM…";
    target.textContent = "";
    const csrf = $("meta[name='csrf-token']")?.content || $("input[name='csrfmiddlewaretoken']")?.value || "";
    try {
      const now = Date.now();
      const requestAt = Math.max(now, nextOSRMRequestAt);
      nextOSRMRequestAt = requestAt + 1000;
      if (requestAt > now) {
        button.textContent = "En attente OSRM…";
        await new Promise((resolve) => setTimeout(resolve, requestAt - now));
      }
      const result = await getJSON("/api/osm-route/", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRFToken": csrf },
        body: JSON.stringify({
          origin_lat: record.origin_lat, origin_lng: record.origin_lng,
          destination_lat: record.destination_lat, destination_lng: record.destination_lng,
          dataset_minutes: record.duration_min,
        }),
      });
      const route = [
        `${Number(record.origin_lat)},${Number(record.origin_lng)}`,
        `${Number(record.destination_lat)},${Number(record.destination_lng)}`,
      ].join(";");
      const mapUrl = `https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=${encodeURIComponent(route)}`;
      target.innerHTML = `OSRM ${minutes(result.osm_minutes)} · ${Number(result.osm_distance_km).toLocaleString("fr-FR")} km · tâche ${minutes(result.dataset_minutes)} · ratio ${result.ratio ?? "—"}× · ${esc(result.assessment)} · <a href="${mapUrl}" target="_blank" rel="noopener">Voir sur OpenStreetMap</a>`;
      renderOSMMap(index, record, result.geometry).catch(() => {
        target.textContent += " · Carte indisponible ; ouvre l’itinéraire sur OpenStreetMap.";
      });
    } catch (error) {
      target.textContent = error.message;
    } finally {
      button.disabled = false;
      button.textContent = "Recalculer OSM";
    }
  }

  async function renderOSMMap(index, record, geometry) {
    const element = $(`#routeMap${index}`);
    if (!element || !geometry?.coordinates?.length) return;
    const maplibregl = await import("https://unpkg.com/maplibre-gl@6.15.0/dist/maplibre-gl.mjs");
    element.classList.remove("hidden");
    const routePoints = geometry.coordinates;
    const midpoint = routePoints[Math.floor(routePoints.length / 2)];
    const map = new maplibregl.Map({
      container: element,
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: midpoint,
      zoom: 12,
      attributionControl: true,
    });
    routeMaps.set(index, map);
    map.addControl(new maplibregl.NavigationControl(), "top-right");
    map.on("load", () => {
      map.addSource("osrm-route", {
        type: "geojson",
        data: { type: "Feature", properties: {}, geometry },
      });
      map.addLayer({
        id: "osrm-route-line",
        type: "line",
        source: "osrm-route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#2879a8", "line-width": 5 },
      });
      const start = [Number(record.origin_lng), Number(record.origin_lat)];
      const end = [Number(record.destination_lng), Number(record.destination_lat)];
      new maplibregl.Marker({ color: "#378d72" }).setLngLat(start).setPopup(new maplibregl.Popup().setText("Départ · GPS à l’acceptation")).addTo(map);
      new maplibregl.Marker({ color: "#c77648" }).setLngLat(end).setPopup(new maplibregl.Popup().setText("Arrivée · GPS du pickup/livraison")).addTo(map);
      const bounds = new maplibregl.LngLatBounds();
      routePoints.forEach((point) => bounds.extend(point));
      map.fitBounds(bounds, { padding: 32, maxZoom: 15 });
    });
  }

  function movePanel(direction) {
    state.panelIndex = (panels.indexOf(state.panel) + direction + panels.length) % panels.length;
    state.panel = panels[state.panelIndex];
    syncHeader();
    loadPanel();
  }

  async function printDashboard() {
    const params = query();
    try {
      const [records, gps, couriers] = await Promise.all([
        getJSON(`/api/analysis/?${new URLSearchParams({ ...Object.fromEntries(params), panel: "records", page: String(state.page) })}`),
        getJSON(`/api/analysis/?${new URLSearchParams({ ...Object.fromEntries(params), panel: "gps" })}`),
        getJSON(`/api/analysis/?${new URLSearchParams({ ...Object.fromEntries(params), panel: "couriers" })}`),
      ]);
      renderRecords(records);
      renderGroups();
      renderGps(gps);
      renderCouriers(couriers.couriers || []);
      $("#printMeta").textContent = `${state.dataset === "pickup" ? "Pickup" : "Delivery"} · ${state.cityName} · ${number(state.cityTotalRows)} lignes ville, ${number(state.cityFilteredRows)} sur la période · du ${getDates().start} au ${getDates().end} · groupe ${variableNames[state.variable]} ${state.value ?? ""}`;
      document.body.classList.add("print-all-panels");
      window.requestAnimationFrame(() => window.print());
    } catch (error) {
      showError(`Impossible de préparer l’impression : ${error.message}`);
    }
  }

  window.addEventListener("afterprint", () => document.body.classList.remove("print-all-panels"));

  $$(".dataset-tab").forEach((button) => button.addEventListener("click", () => {
    state.dataset = button.dataset.dataset;
    state.value = null;
    setActiveButtons();
    loadOptions(false);
  }));
  $$(".city-button").forEach((button) => button.addEventListener("click", () => {
    state.city = button.dataset.city;
    state.cityName = cityNames[state.city];
    state.value = null;
    setActiveButtons();
    loadOptions(false);
  }));
  $$(".variable-tab").forEach((button) => button.addEventListener("click", () => {
    state.variable = button.dataset.variable;
    state.value = null;
    setActiveButtons();
    loadOptions(false);
  }));
  $("#dateStart").addEventListener("change", () => loadOptions(true));
  $("#dateEnd").addEventListener("change", () => loadOptions(true));
  $("#valueSearch").addEventListener("input", renderOptions);
  $("#panelSelect").addEventListener("change", (event) => { state.panel = event.target.value; loadPanel(); });
  $("#previousPanel").addEventListener("click", () => movePanel(-1));
  $("#nextPanel").addEventListener("click", () => movePanel(1));
  $("#previousPage").addEventListener("click", () => { state.page = Math.max(1, state.page - 1); loadPanel(); });
  $("#nextPage").addEventListener("click", () => { state.page += 1; loadPanel(); });
  $("#printButton").addEventListener("click", printDashboard);
  $("#exportRows").addEventListener("click", () => {
    if (!state.records.length) return;
    const columns = Object.keys(state.records[0]);
    const csv = [columns.join(","), ...state.records.map((row) => columns.map((key) => `"${String(row[key] ?? "").replaceAll('"', '""')}"`).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `courses_${state.dataset}_${state.city}_${state.value}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  });

  setActiveButtons();
  syncHeader();
  loadOptions(false);
})();
