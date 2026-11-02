const $ = (s) => document.querySelector(s);
const esc = escH;

let CATALOG = [];
let BY_ID = {};
/** Builder state: [{ id, params, form }] */
let steps = [];
let source = null;
let currentRun = null;

// ── Ready-made recipes (from Blitz's playbooks) ──────────────────────────────
const PRESETS = {
  "ICP list: Find People → Email → Phone": {
    steps: [
      { step: "people_search", params: {
        company: { industry: { include: ["Software Development"] }, employee_range: ["11-50", "51-200"], hq: { country_code: ["US"] } },
        people: { job_level: ["C-Team", "VP", "Director"], location: { country_code: ["US"] } } } },
      { step: "find_email", params: {} },
      { step: "find_phone", params: {} },
    ],
  },
  "Company first: Company Search → Waterfall → Email → Phone": {
    steps: [
      { step: "company_search", params: { company: { industry: { include: ["Software Development"] }, employee_range: ["11-50", "51-200"], hq: { country_code: ["US"] } } } },
      { step: "waterfall_icp", params: { max_results: 2, cascade: [
        { include_title: ["Head of Marketing", "CMO", "VP Marketing"], exclude_title: ["assistant", "intern"] },
        { include_title: ["[CEO]", "Founder", "Co-Founder"] },
      ] } },
      { step: "find_email", params: {} },
      { step: "find_phone", params: {} },
    ],
  },
  "Hiring signal: TAM by Jobs → Waterfall → Email": {
    steps: [
      { step: "tam_by_jobs", params: { job: { title: { include: ["SDR", "Sales Development Representative"] } }, company: { hq: { country_code: { include: ["US"] } } } } },
      { step: "waterfall_icp", params: { max_results: 2, cascade: [
        { include_title: ["VP Sales", "Head of Sales", "CRO", "Chief Revenue Officer"] },
        { include_title: ["[CEO]", "Founder"] },
      ] } },
      { step: "find_email", params: {} },
    ],
  },
  "ABM: Paste domains → Company Enrichment → Waterfall → Email → Phone": {
    steps: [
      { step: "list_domains", params: { list: "stripe.com\nnotion.so\nlinear.app" } },
      { step: "company_enrichment", params: {} },
      { step: "waterfall_icp", params: { max_results: 3, cascade: [
        { include_title: ["CRO", "VP Sales", "Head of Growth"] },
        { include_title: ["Sales Director", "Director of Business Development"] },
      ] } },
      { step: "find_email", params: {} },
      { step: "find_phone", params: {} },
    ],
  },
  "Inbound qualifier: Paste emails → Company Enrichment → ICP Fit": {
    steps: [
      { step: "list_emails", params: { list: "" } },
      { step: "company_enrichment", params: {} },
      { step: "icp_fit", params: { company_sizes: ["11-50", "51-200", "201-500"], countries: ["US"], exclude_title_keywords: ["intern", "student"] } },
    ],
  },
  "Job-change tracker: Saved people → Job Change Check": {
    steps: [
      { step: "saved_people", params: {} },
      { step: "job_change_check", params: { only_changed: true } },
    ],
  },
  "Buying committee: Paste company URLs → 3 roles → Email → Phone": {
    steps: [
      { step: "list_company_urls", params: { list: "https://www.linkedin.com/company/stripe" } },
      { step: "buying_committee", params: {
        decision_makers: ["[CEO]", "Founder", "CRO", "VP Sales"],
        champions: ["Head of Sales", "Sales Director", "Head of Growth"],
        users: ["SDR", "BDR", "Account Executive"],
        per_role: 1 } },
      { step: "find_email", params: {} },
      { step: "find_phone", params: {} },
    ],
  },
  "Hiring-signal alert: TAM by Jobs → Only new → Waterfall → Email": {
    steps: [
      { step: "tam_by_jobs", params: { job: { title: { include: ["SDR", "Sales Development Representative"] } }, company: { hq: { country_code: { include: ["US"] } } } } },
      { step: "only_new", params: { watch_name: "sdr-hiring-us", on: "company" } },
      { step: "waterfall_icp", params: { max_results: 2, cascade: [
        { include_title: ["VP Sales", "Head of Sales", "CRO"] },
        { include_title: ["[CEO]", "Founder"] },
      ] } },
      { step: "find_email", params: {} },
    ],
  },
  "Export: Find People → Email → Google Sheet": {
    steps: [
      { step: "people_search", params: { company: { industry: { include: ["Software Development"] }, hq: { country_code: ["US"] } }, people: { job_level: ["C-Team"] } } },
      { step: "find_email", params: {} },
      { step: "send_google_sheet", params: { apps_script_url: "" } },
    ],
  },
};

// ── Boot ─────────────────────────────────────────────────────────────────────
Promise.all([fetch("/api/steps").then((r) => r.json()), fetch("/api/meta").then((r) => r.json())]).then(([cat, meta]) => {
  CATALOG = cat;
  BY_ID = Object.fromEntries(cat.map((s) => [s.id, s]));
  const a = meta.account;
  $("#account").textContent = a?.error
    ? `API key problem: ${a.error}`
    : `${a.active_plans?.[0]?.name ?? "plan"} · ${Number(a.records_remaining).toLocaleString()} records left · ${a.max_requests_per_seconds} req/s per endpoint · DB: ${meta.db.people} people, ${meta.db.companies} companies`;
  refreshPresetList();
  const first = Object.keys(PRESETS)[0];
  loadPipeline(PRESETS[first]);
  $("#presetSelect").value = "p:" + first; // the default recipe is loaded, so show its name
});

// ── Builder ──────────────────────────────────────────────────────────────────
function entitiesBefore(index) {
  const have = new Set();
  steps.slice(0, index).forEach((s) => BY_ID[s.id].gives.forEach((g) => have.add(g)));
  return have;
}

function drawSteps() {
  // keep what the user typed
  steps.forEach((s) => { if (s.form) s.params = s.form.get() || {}; });
  const box = $("#steps");
  box.innerHTML = "";
  steps.forEach((s, i) => {
    const def = BY_ID[s.id];
    const have = entitiesBefore(i);
    const invalid = i === 0 ? def.group !== "source" : def.group === "source" || (def.needs && !have.has(def.needs));
    const card = h("div", { class: "step" + (invalid ? " invalid" : "") });

    const head = h("div", { class: "step-h" });
    if (i === 0) {
      // Step 1: choose any source
      const sel = h("select", {}, CATALOG.filter((c) => c.group === "source")
        .map((c) => `<option value="${c.id}" ${c.id === s.id ? "selected" : ""}>${esc(c.label)}</option>`).join(""));
      sel.onchange = () => { steps[0] = { id: sel.value, params: {} }; drawSteps(); };
      head.append(h("span", { class: "num" }, "1"), sel);
    } else {
      head.append(h("span", { class: "num" }, String(i + 1)), h("b", {}, esc(def.label)));
      const ctrls = h("span", { class: "ctrls" });
      const up = h("button", { type: "button", class: "link", title: "Move up" }, "↑");
      const rm = h("button", { type: "button", class: "link", title: "Remove" }, "✕");
      up.disabled = i === 1;
      up.onclick = () => { [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]]; drawSteps(); };
      rm.onclick = () => { steps.splice(i, 1); drawSteps(); };
      ctrls.append(up, rm);
      head.append(ctrls);
    }
    card.append(head);
    card.append(h("div", { class: "step-meta" }, `<code>${esc(def.endpoint)}</code> · ${esc(def.help)}` +
      (def.docs ? ` <a href="${esc(def.docs)}" target="_blank">Setup guide →</a>` : "")));
    if (invalid) card.append(h("div", { class: "error" }, def.group === "source" ? "Sources can only be step 1" : `Needs ${def.needs} data. Add a step that provides it first.`));

    const hasFields = Object.keys(def.schema.properties).length > 0;
    s.form = hasFields ? renderStepForm(def.schema, s.params) : null;
    if (s.form) {
      const body = h("div", { class: "step-body" });
      body.append(s.form.el);
      card.append(body);
    }
    box.append(card);

    if (def.dedupe_on) box.append(h("div", { class: "dedupe" }, `🔁 duplicate check on <b>${def.dedupe_on}</b> (skips repeats in this run${def.dedupe_on === "job" ? "" : ", and earlier runs if ticked below"})`));
    box.append(h("div", { class: "down" }, "↓"));
  });
  box.append(h("div", { class: "step save" }, `<div class="step-h"><span class="num">✓</span><b>Save</b></div><div class="step-meta">Database + CSV/Excel download</div>`));
  drawAddSelect();
}

function drawAddSelect() {
  const have = entitiesBefore(steps.length);
  const opts = CATALOG.filter((c) => c.group !== "source");
  const groups = {
    expand: "Find people / jobs for each company",
    enrich: "Add data to each row",
    filter: "Filter / tag rows (free)",
    send: "Send rows somewhere",
  };
  $("#addSelect").innerHTML = Object.entries(groups).map(([g, label]) =>
    `<optgroup label="${label}">` + opts.filter((c) => c.group === g).map((c) => {
      const ok = !c.needs || have.has(c.needs);
      return `<option value="${c.id}" ${ok ? "" : "disabled"}>${esc(c.label)}${ok ? "" : ` (needs ${c.needs})`}</option>`;
    }).join("") + "</optgroup>").join("");
  const firstOk = [...$("#addSelect").options].find((o) => !o.disabled);
  if (firstOk) firstOk.selected = true;
}

$("#addBtn").onclick = () => {
  const id = $("#addSelect").value;
  if (!id) return;
  steps.forEach((s) => { if (s.form) s.params = s.form.get() || {}; });
  steps.push({ id, params: {} });
  drawSteps();
};

function currentPipeline() {
  steps.forEach((s) => { if (s.form) s.params = s.form.get() || {}; });
  return {
    steps: steps.map((s) => ({ step: s.id, params: s.params || {} })),
    maxItems: $("#allItems").checked ? 0 : Number($("#maxItems").value),
    concurrency: Number($("#concurrency").value),
    maxRecords: Number($("#maxRecords").value),
    skipSeenPeople: $("#skipSeenPeople").checked,
    skipSeenCompanies: $("#skipSeenCompanies").checked,
  };
}

function loadPipeline(p) {
  steps = p.steps.filter((s) => BY_ID[s.step]).map((s) => ({ id: s.step, params: structuredClone(s.params || {}) }));
  $("#allItems").checked = p.maxItems === 0;
  if (p.maxItems) $("#maxItems").value = p.maxItems;
  syncAll();
  if (p.concurrency) $("#concurrency").value = p.concurrency;
  if (p.maxRecords) $("#maxRecords").value = p.maxRecords;
  if (p.skipSeenPeople !== undefined) $("#skipSeenPeople").checked = p.skipSeenPeople;
  if (p.skipSeenCompanies !== undefined) $("#skipSeenCompanies").checked = p.skipSeenCompanies;
  drawSteps();
}

// "All results": grey out the number, and warn because record budget still applies.
function syncAll() {
  $("#maxItems").disabled = $("#allItems").checked;
  $("#allHint").hidden = !$("#allItems").checked;
}
$("#allItems").addEventListener("change", () => {
  syncAll();
});

// ── Recipes + saved pipelines (stored in this browser) ────────────────────────
const saved = () => JSON.parse(localStorage.getItem("pipelines") || "{}");
function refreshPresetList() {
  const mine = saved();
  $("#presetSelect").innerHTML = `<option value="">Load a recipe…</option>` +
    `<optgroup label="Recipes">${Object.keys(PRESETS).map((k) => `<option value="p:${esc(k)}">${esc(k)}</option>`).join("")}</optgroup>` +
    (Object.keys(mine).length ? `<optgroup label="My saved pipelines">${Object.keys(mine).map((k) => `<option value="s:${esc(k)}">${esc(k)}</option>`).join("")}</optgroup>` : "");
}
$("#presetSelect").onchange = (e) => {
  const v = e.target.value;
  if (!v) return;
  const name = v.slice(2);
  loadPipeline(v.startsWith("p:") ? PRESETS[name] : saved()[name]);
  // keep the chosen recipe visible in the dropdown
};
$("#saveBtn").onclick = () => {
  const name = prompt("Name this pipeline:");
  if (!name) return;
  const all = saved();
  all[name] = currentPipeline();
  localStorage.setItem("pipelines", JSON.stringify(all));
  refreshPresetList();
  $("#presetSelect").value = "s:" + name; // show the pipeline just saved
};

// ── Run ──────────────────────────────────────────────────────────────────────
$("#startBtn").onclick = async () => {
  $("#formError").textContent = "";
  const body = currentPipeline();
  const r = await fetch("/api/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) { $("#formError").textContent = j.error; return; }
  watch(j.id);
};
$("#stopBtn").onclick = () => currentRun && fetch(`/api/runs/${currentRun}/stop`, { method: "POST" });

let rows = [];
let columns = [];
const PREFERRED = ["full_name", "job_title", "email", "phone", "company_name", "company_domain", "country", "icp_tier",
  "committee_role", "icp_fit", "icp_fit_reasons", "job_change", "previous_company_name", "new_since_last_run",
  "company_industry", "company_size", "company_hq_country", "job_posting_title", "matched_jobs", "matched_people",
  "top_countries", "top_departments", "company_email_domain", "person_linkedin_url", "company_linkedin_url"];

function watch(id) {
  currentRun = id;
  source?.close();
  rows = []; columns = [];
  $("#log").innerHTML = "";
  $("#tbody").innerHTML = "";
  $("#thead").innerHTML = "";
  $("#rowCount").textContent = "";
  $("#downloads").hidden = true;
  $("#startBtn").disabled = true;
  $("#stopBtn").disabled = false;

  source = new EventSource(`/api/runs/${id}/events`);
  source.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.type === "stats") drawStats(ev.stats);
    else if (ev.type === "log") addLog(ev);
    else if (ev.type === "row") addRow(ev.row);
    else if (ev.type === "finished") {
      source.close();
      $("#startBtn").disabled = false;
      $("#stopBtn").disabled = true;
      $("#dlCsv").href = `/api/runs/${id}/rows.csv`;
      $("#dlXlsx").href = `/api/runs/${id}/rows.xlsx`;
      $("#downloads").hidden = false;
    }
  };
}

function drawStats(st) {
  $("#budget").textContent = `${st.records_used.toLocaleString()} / ${st.max_records.toLocaleString()} records used`;
  const parts = st.stages.map((s, i) => {
    const busy = s.status === "running" && (i === 0 || s.in_flight > 0);
    const cls = s.status === "running" ? (busy ? "running" : "") : s.status;
    const hitLabel = { source: "", expand: "found", enrich: "found", filter: "kept", send: "sent" }[s.group];
    return `<div class="stage ${cls}">
      <div class="stage-h"><span class="dot"></span><span class="num">${i + 1}</span>${esc(s.label)}</div>
      <div class="big">${(i === 0 ? s.out + s.duplicates : s.done).toLocaleString()}</div>
      <div class="muted">${i === 0 ? "results" : "processed"}</div>
      ${i > 0 ? kv("working now", s.in_flight) + kv("waiting", s.waiting) : ""}
      ${hitLabel && i > 0 ? kv(hitLabel, s.hits) : ""}
      ${s.dedupe_on ? kv(`duplicate ${s.dedupe_on}s skipped`, s.duplicates) : ""}
      ${kv("passed on", s.out)}
      ${s.filtered ? kv("removed by filter", s.filtered) : ""}
      ${s.skipped ? kv(`skipped (no ${BY_ID[s.id]?.needs ?? "input"})`, s.skipped) : ""}
      ${s.errors ? kv("errors", s.errors, "err") : ""}
      ${kv("records", s.records)}
    </div>`;
  });
  parts.push(`<div class="stage ${st.stages.every((s) => s.status !== "running") ? "done" : ""}">
    <div class="stage-h"><span class="dot"></span><span class="num">✓</span>Save</div>
    <div class="big">${st.saved.toLocaleString()}</div><div class="muted">rows saved</div></div>`);
  $("#pipeline").innerHTML = parts.join(`<div class="arrow">→</div>`);
}
const kv = (k, v, cls = "") => `<div class="kv ${cls}"><span>${esc(k)}</span><b>${Number(v).toLocaleString()}</b></div>`;

function addLog(ev) {
  const li = document.createElement("li");
  li.innerHTML = `<span class="t">${(ev.at / 1000).toFixed(1)}s</span><span class="s">${esc(ev.stage)}</span>${esc(ev.message)}`;
  $("#log").prepend(li);
}

function addRow(row) {
  rows.push(row);
  $("#rowCount").textContent = `(${rows.length})`;
  const newCols = PREFERRED.filter((c) => row[c] !== undefined && !columns.includes(c));
  if (newCols.length) {
    columns = PREFERRED.filter((c) => columns.includes(c) || newCols.includes(c)).slice(0, 12);
    $("#thead").innerHTML = `<tr>${columns.map((c) => `<th>${esc(humanize(c))}</th>`).join("")}</tr>`;
    $("#tbody").innerHTML = "";
    rows.slice(-500).forEach((r) => $("#tbody").prepend(rowEl(r, false)));
  } else {
    $("#tbody").prepend(rowEl(row, true));
  }
}

function rowEl(r, flash) {
  const tr = document.createElement("tr");
  if (flash) tr.className = "new";
  tr.innerHTML = columns.map((c) => {
    const v = r[c];
    if (v === undefined) {
      const status = c === "email" ? r.email_status : c === "phone" ? r.phone_status : "";
      return `<td><span class="none">${esc((status || "").replace(/_/g, " "))}</span></td>`;
    }
    if (/_url$/.test(c)) return `<td><a href="${esc(v)}" target="_blank" rel="noopener">link</a></td>`;
    return `<td title="${esc(v)}">${esc(String(v).slice(0, 60))}</td>`;
  }).join("");
  return tr;
}
