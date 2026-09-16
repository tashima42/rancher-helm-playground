/* global RELEASE_DATA, CHART_DATA */

/** Display labels. Unknown keys from data.js fall back to the raw key. */
const DISTRIBUTION_LABELS = {
  community: "Community (CE)",
  prime: "Prime",
};

const VERSION_TYPE_LABELS = {
  ga: "GA",
  rc: "RC",
  alpha: "Alpha",
  head: "Head",
};

/** Preferred order; anything not listed is appended in data.js order. */
const VERSION_TYPE_ORDER = ["ga", "rc", "alpha", "head"];

/** Version types that only publish pre-release charts, so helm needs --devel. */
const PRERELEASE_TYPES = new Set(["rc", "alpha", "head"]);

const VERSION_TYPE_HINTS = {
  ga: "Stable, generally available releases.",
  rc: "Release candidates. Published to the latest repo, helm needs --devel.",
  alpha: "Early pre-releases. Published to the alpha repo, helm needs --devel.",
  head: "Charts built from the head of a release line, one per commit.",
};

/**
 * Allowed values for options whose chart README documents a fixed set. The
 * README states them in prose, so they are curated here instead of parsed.
 */
const ENUM_OPTIONS = {
  antiAffinity: ["preferred", "required"],
  "auditLog.destination": ["sidecar", "hostPath"],
  "auditLog.image.pullPolicy": ["Always", "Never", "IfNotPresent"],
  "customLogos.accessMode": ["ReadWriteOnce", "ReadWriteMany", "ReadOnlyMany"],
  "customLogos.volumeKind": ["persistentVolumeClaim", "configMap"],
  "gateway.gatewayClass.tls.source": ["rancher", "letsEncrypt", "secret"],
  "image.pullPolicy": ["Always", "Never", "IfNotPresent"],
  "ingress.tls.source": ["rancher", "letsEncrypt", "secret"],
  "letsEncrypt.environment": ["staging", "production"],
  "networkExposure.type": ["ingress", "gateway", "none"],
  "postDelete.image.pullPolicy": ["Always", "Never", "IfNotPresent"],
  "service.type": ["NodePort", "LoadBalancer", "ClusterIP"],
  tls: ["ingress", "external"],
};

/** Shown first, ahead of the per-section groups. */
const COMMON_PATHS = [
  "hostname",
  "bootstrapPassword",
  "replicas",
  "ingress.tls.source",
  "letsEncrypt.email",
  "letsEncrypt.environment",
  "privateCA",
];

/**
 * Real chart options that the README documents but values.yaml leaves out,
 * so they get a field too.
 */
const EXTRA_FIELDS = [
  { path: "hostname", type: "string", defaultValue: "" },
  { path: "letsEncrypt.email", type: "string", defaultValue: "" },
  { path: "extraEnv", type: "yaml", defaultValue: [] },
  { path: "ingress.configurationSnippet", type: "string", defaultValue: "" },
  { path: "proxy", type: "string", defaultValue: "" },
  { path: "customLogos.volumeName", type: "string", defaultValue: "" },
  { path: "customLogos.storageClass", type: "string", defaultValue: "" },
];

/**
 * Documented in the chart README but superseded by `image.*` in values.yaml;
 * setting them has no effect, so they are left out of the form.
 */
const STALE_OPTIONS = new Set(["rancherImage", "rancherImageTag", "rancherImagePullPolicy"]);

/** Top-level key used for root-level values. */
const ROOT_GROUP = "general";

/** Selected on load, falling back to whatever the data offers. */
const DEFAULT_SELECTION = { distribution: "prime", versionType: "head" };

const state = {
  distribution: null,
  versionType: null,
  version: "",
  releaseName: "rancher",
  namespace: "cattle-system",
  /** Explicit user edits, keyed by value path, e.g. { "ingress.tls.source": "letsEncrypt" }. */
  overrides: {},
};

/** Groups the user has expanded; kept open across re-renders. */
const openGroups = new Set();

const el = {
  distributionChoices: document.getElementById("distribution-choices"),
  versionTypeChoices: document.getElementById("version-type-choices"),
  versionTypeHint: document.getElementById("version-type-hint"),
  version: document.getElementById("version"),
  chartHint: document.getElementById("chart-hint"),
  releaseName: document.getElementById("release-name"),
  namespace: document.getElementById("namespace"),
  commonFields: document.getElementById("common-fields"),
  valueGroups: document.getElementById("value-groups"),
  valuesSummary: document.getElementById("values-summary"),
  resetValues: document.getElementById("reset-values"),
  chartRepo: document.getElementById("chart-repo"),
  helmCommand: document.getElementById("helm-command"),
  valuesYaml: document.getElementById("values-yaml"),
};

function label(map, key) {
  return map[key] || key;
}

function distributions() {
  return Object.keys(RELEASE_DATA);
}

/** Every version type present in the data, ordered by VERSION_TYPE_ORDER first. */
function versionTypes() {
  const found = new Set();
  distributions().forEach((distribution) => {
    Object.keys(RELEASE_DATA[distribution]).forEach((type) => found.add(type));
  });
  const ordered = VERSION_TYPE_ORDER.filter((type) => found.has(type));
  const extra = [...found].filter((type) => !VERSION_TYPE_ORDER.includes(type));
  return [...ordered, ...extra];
}

function entryFor(distribution, versionType) {
  const byType = RELEASE_DATA[distribution];
  return byType ? byType[versionType] : undefined;
}

/** Chart.yaml + default values + documented options for the current selection. */
function chartFor(distribution, versionType) {
  const byType = CHART_DATA[distribution];
  return byType ? byType[versionType] : undefined;
}

function isAvailable(distribution, versionType) {
  return Boolean(entryFor(distribution, versionType));
}

/** Helm repo alias, unique per distribution + version type pair. */
function repoAlias() {
  return `rancher-${state.distribution}-${state.versionType}`;
}

function normalizedVersion() {
  return state.version.trim().replace(/^v/, "");
}

function getAtPath(root, path) {
  return path.split(".").reduce((node, key) => {
    if (node === null || typeof node !== "object") return undefined;
    return node[key];
  }, root);
}

/* --------------------------------------------------------------------- *
 * Field model: one entry per documented chart option.
 * --------------------------------------------------------------------- */

/** Drops the README's leading type marker so the description reads as a sentence. */
function cleanDescription(description) {
  return description
    .trim()
    .replace(/^\*{0,3}(string|bool|boolean|int|integer|list|map)\*{0,3}\s*-?\s*/i, "")
    .replace(/\*\*\*|\*\*|\*/g, "")
    .trim();
}

/** Renders a default container value as the YAML text shown in a textarea. */
function defaultYamlText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return String(value);
  if (isEmptyContainer(value)) return Array.isArray(value) ? "[]" : "{}";
  return toYaml(value).trimEnd();
}

/** Infers the control to render from the shape of the chart's own default. */
function typeOfValue(value) {
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return "int";
  if (value !== null && typeof value === "object") return "yaml";
  return "string";
}

/**
 * Flattens values.yaml into leaves. Arrays and empty maps stay whole: they are
 * edited as raw YAML rather than broken into per-index fields.
 */
function collectLeaves(node, prefix, out) {
  Object.keys(node).forEach((key) => {
    const path = prefix ? `${prefix}.${key}` : key;
    const value = node[key];
    const isWalkable =
      value !== null && typeof value === "object" && !Array.isArray(value) && !isEmptyContainer(value);

    if (isWalkable) collectLeaves(value, path, out);
    else out.push({ path, value });
  });
  return out;
}

/**
 * One field per value the chart actually accepts. values.yaml is the source of
 * truth for the list and the defaults; the README table only adds descriptions.
 */
function buildFields() {
  const chart = chartFor(state.distribution, state.versionType);
  if (!chart) return [];

  const docs = new Map(chart.options.map((option) => [option.path, option]));
  const leaves = collectLeaves(chart.values, "", []);
  const known = new Set(leaves.map((leaf) => leaf.path));

  EXTRA_FIELDS.forEach((extra) => {
    if (known.has(extra.path)) return;
    const leaf = { path: extra.path, value: extra.defaultValue };
    // Insert next to the siblings it belongs with, so form and output order stay readable.
    const group = extra.path.split(".")[0];
    const lastSibling = leaves.map((item) => item.path.split(".")[0]).lastIndexOf(group);
    if (lastSibling === -1) leaves.push(leaf);
    else leaves.splice(lastSibling + 1, 0, leaf);
  });

  return leaves
    .filter((leaf) => !STALE_OPTIONS.has(leaf.path))
    .map((leaf) => {
      // values.yaml writes an unset key as `systemDefaultRegistry:`, which parses as null.
      const defaultValue = leaf.value === null ? "" : leaf.value;
      const type = typeOfValue(defaultValue);
      const option = docs.get(leaf.path);
      const segments = leaf.path.split(".");

      return {
        path: leaf.path,
        group: segments.length > 1 ? segments[0] : ROOT_GROUP,
        common: COMMON_PATHS.includes(leaf.path),
        type,
        description: option ? cleanDescription(option.description) : "",
        defaultValue,
        defaultText: type === "yaml" ? defaultYamlText(defaultValue) : String(defaultValue),
        choices: ENUM_OPTIONS[leaf.path],
      };
    });
}

/** Current value of a field: the user's override, or the chart default. */
function fieldValue(field) {
  return Object.prototype.hasOwnProperty.call(state.overrides, field.path)
    ? state.overrides[field.path]
    : field.type === "yaml"
      ? field.defaultText
      : field.defaultValue;
}

function isChanged(field) {
  const current = fieldValue(field);
  if (field.type === "yaml") return current.trim() !== field.defaultText.trim();
  if (field.type === "int") return Number(current) !== Number(field.defaultValue);
  if (field.type === "bool") return Boolean(current) !== Boolean(field.defaultValue);
  return String(current) !== String(field.defaultValue);
}

/* --------------------------------------------------------------------- *
 * YAML output
 * --------------------------------------------------------------------- */

function isEmptyContainer(value) {
  return Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0;
}

function scalarToYaml(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);

  const text = String(value);
  // Quote anything YAML would otherwise read as a non-string. Indicators such as
  // @ or | only matter at the start of a scalar, ":" only before a space.
  const needsQuotes =
    text === "" ||
    /^\s|\s$/.test(text) ||
    /^(true|false|null|yes|no|on|off|~)$/i.test(text) ||
    /^-?\d+(\.\d+)?$/.test(text) ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(text) ||
    /:(\s|$)/.test(text) ||
    /\s#/.test(text) ||
    /[\n\r\t]/.test(text);

  return needsQuotes ? `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : text;
}

/** Minimal YAML serializer for the plain objects that come out of charts.js. */
function toYaml(value, indent = 0) {
  const pad = "  ".repeat(indent);

  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]\n`;
    return value
      .map((item) =>
        item !== null && typeof item === "object"
          ? `${pad}-\n${toYaml(item, indent + 1)}`
          : `${pad}- ${scalarToYaml(item)}\n`,
      )
      .join("");
  }

  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return `${pad}{}\n`;
    return keys
      .map((key) => {
        const child = value[key];
        if (child !== null && typeof child === "object") {
          return isEmptyContainer(child)
            ? `${pad}${key}: ${Array.isArray(child) ? "[]" : "{}"}\n`
            : `${pad}${key}:\n${toYaml(child, indent + 1)}`;
        }
        return `${pad}${key}: ${scalarToYaml(child)}\n`;
      })
      .join("");
  }

  return `${pad}${scalarToYaml(value)}\n`;
}

function setLeaf(tree, path, leaf) {
  const keys = path.split(".");
  const last = keys.pop();
  const parent = keys.reduce((node, key) => {
    if (node[key] === undefined || node[key].__leaf) node[key] = {};
    return node[key];
  }, tree);
  parent[last] = leaf;
}

/** Serializes the override tree; `raw` leaves are spliced in as typed. */
function renderTree(node, indent = 0) {
  const pad = "  ".repeat(indent);

  return Object.keys(node)
    .map((key) => {
      const child = node[key];
      if (!child.__leaf) return `${pad}${key}:\n${renderTree(child, indent + 1)}`;

      if (child.kind === "raw") {
        const text = child.text.trim();
        if (text === "") return "";
        // Flow style ([], {a: 1}) sits on the key's line; block style must be indented below it.
        if (/^[[{]/.test(text) && !text.includes("\n")) return `${pad}${key}: ${text}\n`;
        return `${pad}${key}:\n${text
          .split("\n")
          .map((line) => (line.trim() === "" ? "" : `${pad}  ${line}`))
          .join("\n")}\n`;
      }
      return `${pad}${key}: ${scalarToYaml(child.value)}\n`;
    })
    .join("");
}

function changedFields() {
  return buildFields().filter(isChanged);
}

function buildValuesYaml(fields) {
  const tree = {};
  fields.forEach((field) => {
    const current = fieldValue(field);
    if (field.type === "yaml") {
      setLeaf(tree, field.path, { __leaf: true, kind: "raw", text: current });
    } else {
      const value =
        field.type === "int" ? Number(current) : field.type === "bool" ? Boolean(current) : current;
      setLeaf(tree, field.path, { __leaf: true, kind: "scalar", value });
    }
  });
  return renderTree(tree);
}

/* --------------------------------------------------------------------- *
 * Rendering
 * --------------------------------------------------------------------- */

function renderChoices(container, name, items, onChange) {
  container.replaceChildren();
  items.forEach((item) => {
    const wrapper = document.createElement("label");
    wrapper.className = "choice";

    const input = document.createElement("input");
    input.type = "radio";
    input.name = name;
    input.value = item.value;
    input.checked = item.checked;
    input.disabled = Boolean(item.disabled);
    input.addEventListener("change", () => onChange(item.value));

    const text = document.createElement("span");
    text.textContent = item.label;
    if (item.disabled) {
      text.title = `Not published for ${label(DISTRIBUTION_LABELS, state.distribution)}`;
    }

    wrapper.append(input, text);
    container.append(wrapper);
  });
}

/** Renders a description, turning markdown links into real links. */
function renderDescription(text) {
  const fragment = document.createDocumentFragment();
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  let index = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > index) fragment.append(text.slice(index, match.index));
    const link = document.createElement("a");
    link.href = match[2];
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    link.textContent = match[1];
    fragment.append(link);
    index = match.index + match[0].length;
  }
  if (index < text.length) fragment.append(text.slice(index));
  return fragment;
}

function onFieldChange(field, value) {
  state.overrides[field.path] = value;
  renderValuesFields();
  renderOutput();
}

function renderField(field) {
  const wrapper = document.createElement("div");
  wrapper.className = "value-field";
  if (isChanged(field)) wrapper.dataset.changed = "true";

  const labelEl = document.createElement("label");
  labelEl.className = "value-label";
  labelEl.htmlFor = `field-${field.path}`;
  labelEl.textContent = field.path;

  const control = buildControl(field);
  control.id = `field-${field.path}`;

  wrapper.append(labelEl, control);

  if (field.description) {
    const help = document.createElement("p");
    help.className = "value-help";
    help.append(renderDescription(field.description));
    wrapper.append(help);
  }
  return wrapper;
}

function buildControl(field) {
  const current = fieldValue(field);

  if (field.type === "bool") {
    const select = document.createElement("select");
    [true, false].forEach((option) => {
      const node = document.createElement("option");
      node.value = String(option);
      node.textContent = String(option);
      node.selected = Boolean(current) === option;
      select.append(node);
    });
    select.addEventListener("change", () => onFieldChange(field, select.value === "true"));
    return select;
  }

  if (field.type === "yaml") {
    const textarea = document.createElement("textarea");
    textarea.rows = Math.min(8, Math.max(2, String(current).split("\n").length));
    textarea.spellcheck = false;
    textarea.value = current;
    textarea.addEventListener("input", () => {
      state.overrides[field.path] = textarea.value;
      renderOutput();
      textarea.closest(".value-field").dataset.changed = String(isChanged(field));
    });
    return textarea;
  }

  if (field.choices) {
    const select = document.createElement("select");
    const choices = field.choices.includes(String(field.defaultValue))
      ? field.choices
      : [String(field.defaultValue), ...field.choices];
    choices.forEach((option) => {
      const node = document.createElement("option");
      node.value = option;
      node.textContent = option === "" ? "(unset)" : option;
      node.selected = String(current) === option;
      select.append(node);
    });
    select.addEventListener("change", () => onFieldChange(field, select.value));
    return select;
  }

  const input = document.createElement("input");
  input.type = field.type === "int" ? "number" : "text";
  input.spellcheck = false;
  input.value = current;
  if (field.defaultValue === "") input.placeholder = "unset";
  input.addEventListener("input", () => {
    state.overrides[field.path] = field.type === "int" ? input.value : input.value;
    renderOutput();
    input.closest(".value-field").dataset.changed = String(isChanged(field));
  });
  return input;
}

function renderForm() {
  renderChoices(
    el.distributionChoices,
    "distribution",
    distributions().map((distribution) => ({
      value: distribution,
      label: label(DISTRIBUTION_LABELS, distribution),
      checked: distribution === state.distribution,
    })),
    selectDistribution,
  );

  renderChoices(
    el.versionTypeChoices,
    "version-type",
    versionTypes().map((versionType) => ({
      value: versionType,
      label: label(VERSION_TYPE_LABELS, versionType),
      checked: versionType === state.versionType,
      disabled: !isAvailable(state.distribution, versionType),
    })),
    selectVersionType,
  );

  el.versionTypeHint.textContent = VERSION_TYPE_HINTS[state.versionType] || "";

  const chart = chartFor(state.distribution, state.versionType);
  el.version.placeholder = chart ? chart.chart.version : "leave empty for the latest in the repo";
  el.chartHint.textContent = chart
    ? `Values below come from the example chart ${chart.chart.version} (app ${chart.chart.appVersion}). Leave empty to install the latest in the repo.`
    : "";

  renderValuesFields();
}

/** One collapsible section per top-level key, in values.yaml order. */
function renderGroups(fields) {
  const groups = new Map();
  fields.forEach((field) => {
    if (!groups.has(field.group)) groups.set(field.group, []);
    groups.get(field.group).push(field);
  });

  return [...groups].map(([name, groupFields]) => {
    const details = document.createElement("details");
    details.className = "advanced";
    if (openGroups.has(name)) details.open = true;
    details.addEventListener("toggle", () => {
      if (details.open) openGroups.add(name);
      else openGroups.delete(name);
    });

    const summary = document.createElement("summary");
    summary.textContent = name;

    const count = document.createElement("span");
    count.className = "count";
    const changed = groupFields.filter(isChanged).length;
    count.textContent = changed ? ` (${groupFields.length}, ${changed} changed)` : ` (${groupFields.length})`;
    summary.append(count);

    const body = document.createElement("div");
    body.className = "fields";
    body.append(...groupFields.map(renderField));

    details.append(summary, body);
    return details;
  });
}

function renderValuesFields() {
  const fields = buildFields();
  const byPath = new Map(fields.map((field) => [field.path, field]));
  const common = COMMON_PATHS.map((path) => byPath.get(path)).filter(Boolean);

  el.commonFields.replaceChildren(...common.map(renderField));
  el.valueGroups.replaceChildren(...renderGroups(fields.filter((field) => !field.common)));

  const changed = fields.filter(isChanged).length;
  el.valuesSummary.textContent = changed
    ? `${changed} value${changed === 1 ? "" : "s"} changed from the chart defaults.`
    : "Only values you change are written to values.yaml.";
  el.resetValues.hidden = changed === 0;
}

function selectDistribution(distribution) {
  state.distribution = distribution;
  // The selected version type may not exist for this distribution (e.g. community head).
  if (!isAvailable(distribution, state.versionType)) {
    state.versionType = versionTypes().find((type) => isAvailable(distribution, type));
  }
  renderForm();
  renderOutput();
}

function selectVersionType(versionType) {
  state.versionType = versionType;
  renderForm();
  renderOutput();
}

function buildHelmCommand(chartRepo, hasValues) {
  const alias = repoAlias();
  const version = normalizedVersion();

  const install = [
    `helm upgrade --install ${state.releaseName || "rancher"} ${alias}/rancher`,
    `--namespace ${state.namespace || "cattle-system"}`,
    "--create-namespace",
  ];

  if (version) install.push(`--version ${version}`);
  if (PRERELEASE_TYPES.has(state.versionType)) install.push("--devel");
  if (hasValues) install.push("--values values.yaml");

  return [
    `helm repo add ${alias} ${chartRepo}`,
    "helm repo update",
    "",
    install.join(" \\\n  "),
  ].join("\n");
}

function setCode(node, text, emptyText) {
  const isEmpty = !text;
  node.textContent = isEmpty ? emptyText : text;
  node.classList.toggle("is-empty", isEmpty);
}

function renderOutput() {
  const entry = entryFor(state.distribution, state.versionType);

  if (!entry) {
    const combination = `${label(DISTRIBUTION_LABELS, state.distribution)} ${label(
      VERSION_TYPE_LABELS,
      state.versionType,
    )}`;
    setCode(el.chartRepo, "", `No chart repo published for ${combination}.`);
    setCode(el.helmCommand, "", "Pick an available distribution and version type.");
    setCode(el.valuesYaml, "", "# nothing to generate");
    return;
  }

  const fields = changedFields();
  setCode(el.chartRepo, entry.chartRepo, "");
  setCode(el.helmCommand, buildHelmCommand(entry.chartRepo, fields.length > 0), "");
  setCode(
    el.valuesYaml,
    fields.length ? buildValuesYaml(fields) : "",
    "# no custom values yet — the chart defaults are used",
  );
}

function bindInput(node, key) {
  node.addEventListener("input", () => {
    state[key] = node.value;
    renderOutput();
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // The clipboard API needs a secure context; fall back for file:// and http://.
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    return ok;
  }
}

function bindCopyButtons() {
  document.querySelectorAll(".copy").forEach((button) => {
    button.addEventListener("click", async () => {
      const target = document.getElementById(button.dataset.copyTarget);
      if (!target || target.classList.contains("is-empty")) return;

      const copied = await copyText(target.textContent);
      button.textContent = copied ? "Copied" : "Failed";
      button.dataset.copied = String(copied);
      setTimeout(() => {
        button.textContent = "Copy";
        delete button.dataset.copied;
      }, 1500);
    });
  });
}

function init() {
  state.distribution = RELEASE_DATA[DEFAULT_SELECTION.distribution]
    ? DEFAULT_SELECTION.distribution
    : distributions()[0];
  state.versionType = isAvailable(state.distribution, DEFAULT_SELECTION.versionType)
    ? DEFAULT_SELECTION.versionType
    : versionTypes().find((type) => isAvailable(state.distribution, type));
  state.releaseName = el.releaseName.value;
  state.namespace = el.namespace.value;

  bindInput(el.version, "version");
  bindInput(el.releaseName, "releaseName");
  bindInput(el.namespace, "namespace");
  bindCopyButtons();

  el.resetValues.addEventListener("click", () => {
    state.overrides = {};
    renderValuesFields();
    renderOutput();
  });

  renderForm();
  renderOutput();
}

init();
