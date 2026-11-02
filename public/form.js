// Turns a JSON schema (from Blitz's OpenAPI spec) into a form.
// renderField(...) returns { el, get } where get() returns the value, or undefined when empty.

// Fields shown up front; everything else goes under "More filters".
const COMMON = new Set([
  "company", "people", "job", "list", "cascade", "us_only",
  "industry", "employee_range", "hq", "keywords", "country_code", "type",
  "job_title", "job_level", "job_function", "location", "title", "include_title", "exclude_title",
  "max_results", "is_recent_hire", "date_posted", "seniority", "name", "size",
  // custom (non-Blitz) step settings
  "run_id", "decision_makers", "champions", "users", "per_role", "only_changed",
  "industries", "company_sizes", "countries", "title_keywords", "exclude_title_keywords", "drop_non_fit",
  "watch_name", "on", "apps_script_url", "url", "auth_header",
]);

const humanize = (k) => k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bHq\b/, "HQ").replace(/\bIcp\b/, "ICP").replace(/\bMx\b/, "MX");
const escH = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const isEmpty = (v) => v === undefined || (Array.isArray(v) && v.length === 0) || (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);

function norm(s) {
  if (s && s.anyOf) return s.anyOf.find((x) => x.type !== "null") ?? s.anyOf[0];
  return s || {};
}
function h(tag, attrs = {}, html = "") {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.innerHTML = html;
  return el;
}
const isSimple = (s) => { s = norm(s); return s.type !== "object" && !(s.type === "array" && norm(s.items).type === "object"); };

/** Render the top-level properties of a step's schema. */
function renderStepForm(schema, value) {
  return renderObject("", schema, value || {}, 0, true);
}

function renderField(name, s, value, depth) {
  s = norm(s);
  if (s.type === "object" && s.properties) return renderObject(name, s, value || {}, depth, false);
  if (s.type === "array") {
    const items = norm(s.items);
    if (items.enum) return items.enum.length <= 40 ? renderChecks(name, s, items.enum, value) : renderChips(name, s, items.enum, value);
    if (items.type === "object") return renderRepeat(name, s, items, value, depth);
    return renderList(name, s, items, value);
  }
  if (s.type === "boolean") return renderBool(name, s, value);
  if (s.type === "number" || s.type === "integer") return renderNumber(name, s, value);
  if (s.enum) return renderSelect(name, s, value);
  return renderText(name, s, value);
}

function renderObject(name, s, value, depth, top) {
  const props = Object.entries(s.properties || {});
  // Small all-simple objects (include/exclude, min/max) render inline on one row.
  if (!top && props.length <= 3 && props.every(([, p]) => isSimple(p))) {
    const wrap = h("div", { class: "field" });
    wrap.append(h("div", { class: "flabel", title: s.description || "" }, escH(humanize(name))));
    const row = h("div", { class: "row tight" });
    const kids = props.map(([k, p]) => [k, renderField(k, p, value[k], depth + 1)]);
    kids.forEach(([, f]) => row.append(f.el));
    wrap.append(row);
    return { el: wrap, get: () => collect(kids) };
  }
  const box = top ? h("div") : h("fieldset", { class: "obj" });
  if (!top) box.append(h("legend", { title: s.description || "" }, escH(humanize(name))));
  const more = h("details", { class: "more" });
  const kids = [];
  let moreCount = 0;
  for (const [k, p] of props) {
    const f = renderField(k, p, value[k], depth + 1);
    kids.push([k, f]);
    if (COMMON.has(k) || value[k] !== undefined) box.append(f.el);
    else { more.append(f.el); moreCount++; }
  }
  if (moreCount) {
    more.prepend(h("summary", {}, `More ${top ? "settings" : humanize(name).toLowerCase() + " filters"} (${moreCount})`));
    box.append(more);
  }
  return { el: box, get: () => collect(kids) };
}

function collect(kids) {
  const out = {};
  for (const [k, f] of kids) { const v = f.get(); if (!isEmpty(v)) out[k] = v; }
  return isEmpty(out) ? undefined : out;
}

function labelled(name, s, input) {
  const l = h("label", { title: s.description || "" });
  l.append(document.createTextNode(humanize(name)));
  l.append(input);
  return l;
}

function renderText(name, s, value) {
  const input = s.format === "textarea" ? h("textarea", { rows: "6" }) : h("input");
  input.value = value ?? "";
  if (s.description) input.placeholder = s.description.slice(0, 60);
  return { el: labelled(name, s, input), get: () => input.value.trim() || undefined };
}

function renderNumber(name, s, value) {
  const input = h("input", { type: "number" });
  if (s.minimum !== undefined) input.min = s.minimum;
  if (s.maximum !== undefined) input.max = s.maximum;
  input.placeholder = s.default !== undefined && s.default !== 0 ? `default ${s.default}` : "";
  if (value !== undefined) input.value = value;
  const lo = s.minimum, hi = s.maximum;
  // Pull typed values back into the range the API accepts (e.g. Waterfall max results ≤ 100).
  const clampNum = () => {
    if (input.value === "") return;
    let n = Number(input.value);
    if (lo !== undefined && n < lo) n = lo;
    if (hi !== undefined && n > hi) n = hi;
    if (String(n) !== input.value) { input.value = n; input.classList.add("clamped"); setTimeout(() => input.classList.remove("clamped"), 1200); }
  };
  input.addEventListener("change", clampNum);
  clampNum();
  const range = lo !== undefined && hi !== undefined ? ` (${lo}–${hi})` : hi !== undefined ? ` (max ${hi})` : "";
  return { el: labelled(name + range, s, input), get: () => { clampNum(); return input.value === "" ? undefined : Number(input.value); } };
}

function renderBool(name, s, value) {
  const dflt = s.default ?? false;
  const l = h("label", { class: "inline", title: s.description || "" });
  const cb = h("input", { type: "checkbox" });
  cb.checked = value ?? dflt;
  l.append(cb, document.createTextNode(" " + humanize(name)));
  return { el: l, get: () => (cb.checked === dflt ? undefined : cb.checked) };
}

function renderSelect(name, s, value) {
  const sel = h("select", {}, `<option value="">(any)</option>` + s.enum.map((e) => `<option ${e === value ? "selected" : ""}>${escH(e)}</option>`).join(""));
  return { el: labelled(name, s, sel), get: () => sel.value || undefined };
}

/** Free-text list: comma separated. */
function renderList(name, s, items, value) {
  const input = h("input", { placeholder: "comma separated" });
  input.value = (value || []).join(", ");
  const num = items.type === "number" || items.type === "integer";
  return {
    el: labelled(name, s, input),
    get: () => {
      const v = input.value.split(",").map((x) => x.trim()).filter(Boolean);
      return v.length ? (num ? v.map(Number) : v) : undefined;
    },
  };
}

function renderChecks(name, s, options, value) {
  const wrap = h("div", { class: "field" });
  wrap.append(h("div", { class: "flabel", title: s.description || "" }, escH(humanize(name))));
  const box = h("div", { class: "checks" + (options.length > 10 ? " small" : "") });
  const set = new Set(value || []);
  const cbs = options.map((o) => {
    const l = h("label");
    const cb = h("input", { type: "checkbox" });
    cb.checked = set.has(o);
    l.append(cb, document.createTextNode(o));
    box.append(l);
    return [o, cb];
  });
  wrap.append(box);
  return { el: wrap, get: () => { const v = cbs.filter(([, c]) => c.checked).map(([o]) => o); return v.length ? v : undefined; } };
}

let chipId = 0;
/** Searchable multi-select for long enums (e.g. 534 industries). */
function renderChips(name, s, options, value) {
  const id = "dl" + chipId++;
  const wrap = h("div", { class: "field" });
  wrap.append(h("div", { class: "flabel", title: s.description || "" }, escH(humanize(name))));
  const chips = h("div", { class: "chips" });
  const input = h("input", { list: id, placeholder: `Type to search ${options.length} options` });
  const dl = h("datalist", { id }, options.map((o) => `<option value="${escH(o)}">`).join(""));
  const selected = new Set(value || []);
  const draw = () => {
    chips.innerHTML = [...selected].map((v) => `<span class="chip" data-v="${escH(v)}">${escH(v)} ✕</span>`).join("");
    chips.querySelectorAll(".chip").forEach((c) => (c.onclick = () => { selected.delete(c.dataset.v); draw(); }));
  };
  const tryAdd = () => {
    const v = input.value.trim();
    const match = options.find((o) => o.toLowerCase() === v.toLowerCase());
    if (match) { selected.add(match); input.value = ""; draw(); }
  };
  input.addEventListener("change", tryAdd);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); tryAdd(); } });
  wrap.append(chips, input, dl);
  draw();
  return { el: wrap, get: () => (selected.size ? [...selected] : undefined) };
}

/** Array of objects, e.g. Waterfall cascade tiers. */
function renderRepeat(name, s, itemSchema, value, depth) {
  const wrap = h("fieldset", { class: "obj" });
  wrap.append(h("legend", { title: s.description || "" }, escH(humanize(name))));
  const list = h("div");
  const add = h("button", { type: "button", class: "secondary small" }, "+ Add " + (name === "cascade" ? "tier" : "item"));
  wrap.append(list, add);
  let entries = [];
  const draw = (vals) => {
    list.innerHTML = "";
    entries = vals.map((v, i) => {
      const f = renderObject("", itemSchema, v || {}, depth + 1, true);
      const box = h("div", { class: "repeat" });
      const head = h("div", { class: "row between" }, `<b>${name === "cascade" ? "Tier" : "Item"} ${i + 1}</b>`);
      const rm = h("button", { type: "button", class: "link" }, "remove");
      rm.onclick = () => draw(entries.filter((_, j) => j !== i).map((e) => e.get() || {}));
      head.append(rm);
      box.append(head, f.el);
      list.append(box);
      return f;
    });
  };
  add.onclick = () => draw([...entries.map((e) => e.get() || {}), {}]);
  draw(value && value.length ? value : [{}]);
  return { el: wrap, get: () => { const v = entries.map((e) => e.get()).filter((x) => !isEmpty(x)); return v.length ? v : undefined; } };
}
