/**
 * Everything about a release — the repositories, the version lists and the
 * chart values behind every version — is read from data/, which
 * tools/chart-data generates from what the repositories publish.
 */
const DATA_ROOT = "data/v1";


/** The only data layout this build understands. See data/v1/index.json. */
const SUPPORTED_SCHEMA = 1;

/**
 * Shown first, ahead of the per-section groups. The chart README marks its own
 * common options; these are the ones worth promoting on top of that.
 */
const EXTRA_COMMON_PATHS = ["bootstrapPassword", "replicas"];

/**
 * Documented in the chart README but superseded by `image.*` in values.yaml;
 * setting them has no effect, so they are left out of the form.
 */
const STALE_OPTIONS = new Set(["rancherImage", "rancherImageTag", "rancherImagePullPolicy"]);

/**
 * Values the playground starts from even when the chart ships something else,
 * because they are what a Rancher install usually wants. They behave like any
 * other change: the form shows them as changed, they can be edited back, and a
 * chart version that has no such value simply ignores them.
 *
 * Write every value as the string the form would produce — booleans included,
 * they are re-typed against the chart in view.
 */
const PLAYGROUND_DEFAULTS = {
  agentTLSMode: "system-store",
};

/**
 * The list of name/value pairs the chart appends to the Rancher deployment.
 * It gets its own editor rather than the generic raw-YAML box a list would
 * otherwise get, so it is kept out of the chart values form.
 */
const EXTRA_ENV_PATH = "extraEnv";

/** Top-level key used for root-level values. */
const ROOT_GROUP = "general";

/** Selected on load, falling back to whatever the data offers. */
const DEFAULT_SELECTION = { distribution: "prime", versionType: "head" };

const DEFAULT_RELEASE_NAME = "rancher";
const DEFAULT_NAMESPACE = "cattle-system";

/**
 * First install versus upgrading a release that is already running, and — for an
 * upgrade — what happens to the values the release already has. `flags` are added
 * to the command as written.
 */
const ACTIONS = [
  {
    id: "install",
    label: "Install or upgrade",
    flags: ["--create-namespace"],
    hint: "helm upgrade --install creates the release if it is missing, and creates the namespace.",
  },
  {
    id: "upgrade",
    label: "Upgrade, taking the new chart defaults",
    flags: ["--reset-then-reuse-values"],
    hint: "Adds --reset-then-reuse-values: the new chart's defaults are applied first, then the values you set on the running release, then the ones below. Needs Helm 3.14 or newer.",
  },
  {
    id: "upgrade-reuse",
    label: "Upgrade, keeping the installed values",
    flags: ["--reuse-values"],
    hint: "Adds --reuse-values: the running release's values are carried over as they are, so defaults introduced by a newer chart are not picked up.",
  },
];
const DEFAULT_ACTION = "install";

function currentAction() {
  return ACTIONS.find((action) => action.id === state.action) || ACTIONS[0];
}

/** Whether the changed values travel in a file or on the command line. */
const VALUES_MODES = [
  { id: "set", label: "Flags on the command" },
  { id: "file", label: "values.yaml" },
];
const DEFAULT_VALUES_MODE = "set";

/**
 * Query parameter names. Changed chart values are stored one per parameter,
 * prefixed so they cannot collide with the keys below: `v.ingress.tls.source=secret`.
 */
const URL_KEYS = {
  distribution: "distribution",
  versionType: "type",
  version: "version",
  releaseName: "release",
  namespace: "namespace",
  action: "action",
  valuesMode: "values",
  // Repeated once per pair, as `env=NAME=VALUE`.
  extraEnv: "env",
};
const OVERRIDE_PREFIX = "v.";

/** The version dropdown entry that reveals the free-text version field. */
const CUSTOM_VERSION = "__custom__";

const state = {
  distribution: null,
  versionType: null,
  /** Chart version to install; empty means whatever the repo calls latest. */
  version: "",
  /** True while the version is being typed rather than picked from the list. */
  custom: false,
  /** The version list entry the form is built from, or null. */
  entry: null,
  /** Values, README options and values schema for that entry. */
  chart: null,
  releaseName: "rancher",
  namespace: "cattle-system",
  /** "install" or "upgrade"; see ACTIONS. */
  action: DEFAULT_ACTION,
  /** "file" or "set"; see VALUES_MODES. */
  valuesMode: DEFAULT_VALUES_MODE,
  /** Filters the values form; empty shows the usual common + grouped layout. */
  search: "",
  /** Explicit user edits, keyed by value path, e.g. { "ingress.tls.source": "letsEncrypt" }. */
  overrides: {},
  /** extraEnv, in order: [{ name: "CATTLE_AGENT_IMAGE", value: "…" }]. */
  extraEnv: [],
};

/** The overrides a page with nothing shared into it starts from. */
function seedOverrides() {
  return { ...PLAYGROUND_DEFAULTS };
}

/** The generated data, loaded a file at a time and kept as promises. */
const data = {
  index: null,
  /** "<distribution>/<channel>" -> Promise<version list>. */
  versions: new Map(),
  /** payload hash -> Promise<chart payload>. */
  charts: new Map(),
};

/**
 * Groups start expanded, so everything the chart accepts is visible by
 * scrolling. This is the ones the user has collapsed, kept shut across
 * re-renders.
 */
const closedGroups = new Set();

const el = {
  distributionChoices: document.getElementById("distribution-choices"),
  versionTypeChoices: document.getElementById("version-type-choices"),
  versionTypeHint: document.getElementById("version-type-hint"),
  versionSelect: document.getElementById("version-select"),
  customVersion: document.getElementById("custom-version"),
  version: document.getElementById("version"),
  chartHint: document.getElementById("chart-hint"),
  releaseName: document.getElementById("release-name"),
  namespace: document.getElementById("namespace"),
  actionChoices: document.getElementById("action-choices"),
  actionHint: document.getElementById("action-hint"),
  valuesModeChoices: document.getElementById("values-mode-choices"),
  valuesModeHint: document.getElementById("values-mode-hint"),
  commonFields: document.getElementById("common-fields"),
  valueGroups: document.getElementById("value-groups"),
  valuesSearch: document.getElementById("values-search"),
  valuesSummary: document.getElementById("values-summary"),
  extraEnv: document.getElementById("extra-env"),
  extraEnvHint: document.getElementById("extra-env-hint"),
  addExtraEnv: document.getElementById("add-extra-env"),
  resetValues: document.getElementById("reset-values"),
  copyLink: document.getElementById("copy-link"),
  chartRepo: document.getElementById("chart-repo"),
  helmCommand: document.getElementById("helm-command"),
  valuesYaml: document.getElementById("values-yaml"),
  banner: document.getElementById("banner"),
};

/* --------------------------------------------------------------------- *
 * Generated data
 * --------------------------------------------------------------------- */

/** Reads one generated file, refusing data this build cannot make sense of. */
async function loadJson(path) {
  const response = await fetch(`${DATA_ROOT}/${path}`);
  if (!response.ok) throw new Error(`${path}: ${response.status} ${response.statusText}`);

  const body = await response.json();
  if (body.schemaVersion !== SUPPORTED_SCHEMA) {
    throw new Error(
      `${path}: schemaVersion ${body.schemaVersion}, this page reads ${SUPPORTED_SCHEMA}`,
    );
  }
  return body;
}

function distributions() {
  return data.index.distributions;
}

function distributionFor(id) {
  return distributions().find((distribution) => distribution.id === id);
}

/** Repo URL, labels and version list location for one distribution + type. */
function channelFor(distribution, versionType) {
  return distributionFor(distribution)?.channels.find((channel) => channel.id === versionType);
}

/** Every version type any distribution publishes, in config order. */
function versionTypes() {
  const found = new Map();
  distributions().forEach((distribution) => {
    distribution.channels.forEach((channel) => {
      if (!found.has(channel.id)) found.set(channel.id, channel);
    });
  });
  return [...found.values()];
}

function isAvailable(distribution, versionType) {
  return Boolean(channelFor(distribution, versionType));
}

/** The versions published for one distribution + type, newest first. */
function versionsFor(distribution, versionType) {
  const channel = channelFor(distribution, versionType);
  if (!channel) return Promise.resolve([]);

  const key = `${distribution}/${versionType}`;
  if (!data.versions.has(key)) {
    data.versions.set(
      key,
      loadJson(channel.versions).then((file) => file.versions),
    );
  }
  return data.versions.get(key);
}

/** Values, documented options and values schema for one chart payload. */
function chartPayload(hash) {
  if (!data.charts.has(hash)) data.charts.set(hash, loadJson(`charts/${hash}.json`));
  return data.charts.get(hash);
}

/**
 * Loads the chart the form should describe: the selected version, or the one an
 * install without --version resolves to when the field is empty or names a
 * version the repo does not list.
 */
async function refreshChart() {
  const versions = await versionsFor(state.distribution, state.versionType);
  const wanted = normalizedVersion();
  const latest = channelFor(state.distribution, state.versionType)?.latest;
  const fallback = versions.find((entry) => entry.version === latest) || versions[0];
  const exact = wanted ? versions.find((entry) => entry.version === wanted) : fallback;

  state.entry = exact || fallback || null;
  state.known = Boolean(exact);
  state.chart = state.entry ? await chartPayload(state.entry.chart) : null;
  normalizeOverrides();
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
  const chart = state.chart;
  if (!chart) return [];

  const docs = new Map(chart.options.map((option) => [option.path, option]));
  const leaves = collectLeaves(chart.values, "", []);
  const known = new Set(leaves.map((leaf) => leaf.path));

  // Options the README documents but values.yaml leaves out are real options
  // too, as long as the README states a default the generator could read.
  chart.options.forEach((option) => {
    if (known.has(option.path) || option.default === null) return;
    const leaf = { path: option.path, value: option.default };
    // Insert next to the siblings it belongs with, so form and output order stay readable.
    const group = option.path.split(".")[0];
    const lastSibling = leaves.map((item) => item.path.split(".")[0]).lastIndexOf(group);
    if (lastSibling === -1) leaves.push(leaf);
    else leaves.splice(lastSibling + 1, 0, leaf);
    known.add(option.path);
  });

  return leaves
    .filter((leaf) => !STALE_OPTIONS.has(leaf.path) && leaf.path !== EXTRA_ENV_PATH)
    .map((leaf) => {
      // values.yaml writes an unset key as `systemDefaultRegistry:`, which parses as null.
      const defaultValue = leaf.value === null ? "" : leaf.value;
      const type = typeOfValue(defaultValue);
      const option = docs.get(leaf.path);
      const segments = leaf.path.split(".");
      const seeded = Object.prototype.hasOwnProperty.call(PLAYGROUND_DEFAULTS, leaf.path);

      return {
        path: leaf.path,
        group: segments.length > 1 ? segments[0] : ROOT_GROUP,
        // A value the playground moved off the chart default is worth seeing
        // without hunting for it, so it is promoted alongside the common ones.
        common: option?.section === "common" || EXTRA_COMMON_PATHS.includes(leaf.path) || seeded,
        seeded,
        type,
        description: option ? cleanDescription(option.description) : "",
        defaultValue,
        defaultText: type === "yaml" ? defaultYamlText(defaultValue) : String(defaultValue),
        choices: choicesFor(chart, leaf.path),
      };
    });
}

/**
 * Allowed values for a path, as stated by the chart's own values.schema.json.
 * Charts old enough to ship without one simply get a free-text field.
 */
function choicesFor(chart, path) {
  const allowed = chart.schema[path]?.enum;
  if (!Array.isArray(allowed)) return undefined;

  const choices = [];
  allowed.forEach((value) => {
    // The schema spells an unset value as both null and "".
    const text = value === null ? "" : String(value);
    if (!choices.includes(text)) choices.push(text);
  });
  return choices;
}

/** What the chart itself ships for a field. */
function chartValue(field) {
  return field.type === "yaml" ? field.defaultText : field.defaultValue;
}

/**
 * What the field holds before anyone touches it: the chart default, unless the
 * playground overrides it. This is the baseline "Reset" restores and the one
 * the URL is written against, so a link only carries deliberate edits.
 */
function startingValue(field) {
  if (!field.seeded) return chartValue(field);
  const seeded = PLAYGROUND_DEFAULTS[field.path];
  return field.type === "bool" ? String(seeded) === "true" : seeded;
}

/** Current value of a field: the user's override, or the chart default. */
function fieldValue(field) {
  return Object.prototype.hasOwnProperty.call(state.overrides, field.path)
    ? state.overrides[field.path]
    : chartValue(field);
}

/** Compares two values of one field in that field's own type. */
function sameValue(field, a, b) {
  if (field.type === "yaml") return String(a).trim() === String(b).trim();
  if (field.type === "int") return Number(a) === Number(b);
  if (field.type === "bool") return Boolean(a) === Boolean(b);
  return String(a) === String(b);
}

/** Differs from the chart, so it has to be written to the command or the file. */
function isChanged(field) {
  return !sameValue(field, fieldValue(field), chartValue(field));
}

/** Differs from what the page started with, so a shared link has to carry it. */
function isEdited(field) {
  return !sameValue(field, fieldValue(field), startingValue(field));
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

/** Minimal YAML serializer for the plain objects that come out of the chart payloads. */
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

/** The extraEnv pairs worth emitting; a row still being typed has no name yet. */
function extraEnvEntries() {
  return state.extraEnv
    .map((entry) => ({ name: entry.name.trim(), value: entry.value }))
    .filter((entry) => entry.name !== "");
}

/** extraEnv as the list of name/value maps the chart expects. */
function extraEnvYaml(entries) {
  return entries
    .map((entry) => `- name: ${scalarToYaml(entry.name)}\n  value: ${scalarToYaml(entry.value)}\n`)
    .join("");
}

function buildValuesYaml(fields, env) {
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
  if (env.length) setLeaf(tree, EXTRA_ENV_PATH, { __leaf: true, kind: "raw", text: extraEnvYaml(env) });
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
      text.title = `Not published for ${distributionFor(state.distribution)?.label}`;
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

  // Say so when the value on screen is the playground's choice rather than the
  // chart's, so nobody has to wonder why a fresh page already has a change.
  if (field.seeded && !sameValue(field, startingValue(field), chartValue(field))) {
    const note = document.createElement("p");
    note.className = "value-note";
    const shipped = String(chartValue(field));
    note.textContent = `Set by the playground; the chart ships ${shipped === "" ? "no value" : shipped}.`;
    wrapper.append(note);
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

async function renderForm() {
  renderChoices(
    el.distributionChoices,
    "distribution",
    distributions().map((distribution) => ({
      value: distribution.id,
      label: distribution.label,
      checked: distribution.id === state.distribution,
    })),
    selectDistribution,
  );

  renderChoices(
    el.versionTypeChoices,
    "version-type",
    versionTypes().map((channel) => ({
      value: channel.id,
      label: channel.label,
      checked: channel.id === state.versionType,
      disabled: !isAvailable(state.distribution, channel.id),
    })),
    selectVersionType,
  );

  const channel = channelFor(state.distribution, state.versionType);
  el.versionTypeHint.textContent = channel?.hint || "";

  renderChoices(
    el.actionChoices,
    "action",
    ACTIONS.map((action) => ({
      value: action.id,
      label: action.label,
      checked: action.id === state.action,
    })),
    selectAction,
  );
  el.actionHint.textContent = currentAction().hint;

  renderChoices(
    el.valuesModeChoices,
    "values-mode",
    VALUES_MODES.map((mode) => ({
      value: mode.id,
      label: mode.label,
      checked: mode.id === state.valuesMode,
    })),
    selectValuesMode,
  );

  renderVersionChoices(await versionsFor(state.distribution, state.versionType));
  renderExtraEnv();
  renderValuesFields();
}

/** The dropdown of published versions, plus "latest" and a way out to typing. */
function renderVersionChoices(versions) {
  const select = el.versionSelect;
  const wanted = normalizedVersion();

  const add = (value, text) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    select.append(option);
    return option;
  };

  const latest = channelFor(state.distribution, state.versionType)?.latest;

  select.replaceChildren();
  add("", latest ? `Latest in the repo (${latest})` : "Latest in the repo");
  versions.forEach((entry) => add(entry.version, entry.version));
  add(CUSTOM_VERSION, "Custom version…");

  // A version from a shared link that the repo no longer lists still belongs in
  // the field, so fall back to typing it.
  if (wanted && !versions.some((entry) => entry.version === wanted)) state.custom = true;
  select.value = state.custom ? CUSTOM_VERSION : wanted;

  el.customVersion.hidden = !state.custom;
  el.version.value = state.version;
  el.version.placeholder = versions.length ? versions[0].version : "2.15.1";

  el.chartHint.textContent = chartHint(versions);
}

function chartHint(versions) {
  if (!state.entry) return "No versions published for this combination yet.";

  const source = `The values below come from chart ${state.entry.version}`;
  if (!normalizedVersion()) {
    return `${source}, the version helm resolves to as latest; the command pins it with --version. ${versions.length} versions are published here, most recently pushed first.`;
  }
  if (!state.known) {
    return `${source}: ${normalizedVersion()} is not listed in this repo, so its own values are unknown.`;
  }

  const pushed = state.entry.created ? `, pushed ${state.entry.created.slice(0, 10)}` : "";
  return `${source} (app ${state.entry.appVersion}${pushed}).`;
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
    details.open = !closedGroups.has(name);
    details.addEventListener("toggle", () => {
      if (details.open) closedGroups.delete(name);
      else closedGroups.add(name);
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

/** Every word has to appear somewhere in the path or the description. */
function searchTerms() {
  return state.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function matchesSearch(field, terms) {
  const haystack = `${field.path} ${field.description}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/**
 * extraEnv, one row per pair. The rows are rebuilt only when one is added or
 * removed: typing must not cost the input its focus, so the handlers below
 * redraw the output and leave the form alone.
 */
function renderExtraEnv() {
  el.extraEnv.replaceChildren(...state.extraEnv.map(renderExtraEnvRow));
  renderExtraEnvHint();
}

function renderExtraEnvHint() {
  const count = extraEnvEntries().length;
  el.extraEnvHint.textContent = count
    ? `${count} variable${count === 1 ? "" : "s"} added to the Rancher deployment, as extraEnv[i].name and extraEnv[i].value.`
    : "Nothing here yet. These are set on the Rancher deployment itself, such as CATTLE_AGENT_IMAGE.";
}

function renderExtraEnvRow(entry, index) {
  const row = document.createElement("div");
  row.className = "env-row";

  const head = document.createElement("div");
  head.className = "env-head";

  // The index is the one the --set flags use, so the form reads like the output.
  const label = document.createElement("span");
  label.className = "env-index";
  label.textContent = `${EXTRA_ENV_PATH}[${index}]`;

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "link-button";
  remove.textContent = "Remove";
  remove.setAttribute("aria-label", `Remove ${EXTRA_ENV_PATH}[${index}]`);
  remove.addEventListener("click", () => {
    state.extraEnv.splice(index, 1);
    renderExtraEnv();
    renderOutput();
  });

  head.append(label, remove);
  row.append(
    head,
    extraEnvField(entry, index, "name", "CATTLE_AGENT_IMAGE"),
    extraEnvField(entry, index, "value", "registry.suse.com/rancher/rancher-agent:v2.11.0"),
  );
  return row;
}

function extraEnvField(entry, index, key, placeholder) {
  const field = document.createElement("label");
  field.className = "env-field";

  const caption = document.createElement("span");
  caption.textContent = key;

  const input = document.createElement("input");
  input.type = "text";
  input.spellcheck = false;
  input.value = entry[key];
  input.placeholder = placeholder;
  input.setAttribute("aria-label", `${EXTRA_ENV_PATH}[${index}].${key}`);
  input.addEventListener("input", () => {
    entry[key] = input.value;
    renderExtraEnvHint();
    renderOutput();
  });

  field.append(caption, input);
  return field;
}

function renderValuesFields() {
  const fields = buildFields();
  const terms = searchTerms();
  const changed = fields.filter(isChanged).length;
  const changedText = changed
    ? `${changed} value${changed === 1 ? "" : "s"} changed from the chart defaults.`
    : "Only values you change are written to values.yaml.";

  if (terms.length) {
    // Searching flattens the form: the common/advanced split and the groups only
    // help while browsing, and they hide matches behind collapsed sections.
    const matches = fields.filter((field) => matchesSearch(field, terms));
    el.commonFields.replaceChildren(...matches.map(renderField));
    el.valueGroups.replaceChildren();

    // extraEnv is not one of these fields, so looking for it here finds nothing.
    const elsewhere = terms.some(
      (term) => term.length >= 3 && EXTRA_ENV_PATH.toLowerCase().includes(term),
    )
      ? ` ${EXTRA_ENV_PATH} has its own section above.`
      : "";

    el.valuesSummary.textContent = matches.length
      ? `${matches.length} of ${fields.length} values match. ${changedText}${elsewhere}`
      : `No values match “${state.search.trim()}”.${elsewhere}`;
  } else {
    el.commonFields.replaceChildren(...fields.filter((field) => field.common).map(renderField));
    el.valueGroups.replaceChildren(...renderGroups(fields.filter((field) => !field.common)));
    el.valuesSummary.textContent = changedText;
  }

  // Reset restores the playground's own starting point, so it only makes sense
  // once something has moved away from it.
  el.resetValues.hidden = !fields.some(isEdited);
}

function selectDistribution(distribution) {
  state.distribution = distribution;
  // The selected version type may not exist for this distribution (e.g. community head).
  if (!isAvailable(distribution, state.versionType)) {
    state.versionType = versionTypes().find((channel) =>
      isAvailable(distribution, channel.id),
    )?.id;
  }
  // Version lists are per repo, so a version picked for the old one rarely
  // means anything here.
  resetVersion();
  update();
}

function selectVersionType(versionType) {
  state.versionType = versionType;
  resetVersion();
  update();
}

/** Neither of these changes which chart is loaded, so only the output redraws. */
function selectAction(action) {
  state.action = action;
  el.actionHint.textContent = currentAction().hint;
  renderOutput();
}

function selectValuesMode(mode) {
  state.valuesMode = mode;
  renderOutput();
}

function resetVersion() {
  state.version = "";
  state.custom = false;
}

function selectVersion(value) {
  if (value === CUSTOM_VERSION) {
    state.custom = true;
    el.customVersion.hidden = false;
    el.version.focus();
    return;
  }
  state.custom = false;
  state.version = value;
  update();
}

/**
 * Splits everything that has to reach helm into what the command can carry and
 * what has to stay in a file. --set takes scalars only, so arrays and maps (the
 * fields edited as raw YAML) keep their file even in --set mode; extraEnv is the
 * exception, because helm can address a list entry by index.
 */
function splitValues(fields, env) {
  const onCommand = state.valuesMode === "set";
  return {
    file: onCommand ? fields.filter((field) => field.type === "yaml") : fields,
    set: onCommand ? fields.filter((field) => field.type !== "yaml") : [],
    fileEnv: onCommand ? [] : env,
    setEnv: onCommand ? env : [],
  };
}

function needsValuesFile(split) {
  return split.file.length > 0 || split.fileEnv.length > 0;
}

/** Quotes an argument the shell would otherwise mangle. */
function shellQuote(text) {
  if (text !== "" && !/[^A-Za-z0-9_@%+=:,./-]/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** helm reads "," as a flag separator and "\" as its own escape, inside the value too. */
function helmEscape(value) {
  return value.replace(/([\\,])/g, "\\$1");
}

/** One --set flag. Strings go through --set-string so helm keeps them strings. */
function setFlag(field) {
  const current = fieldValue(field);
  const value =
    field.type === "bool"
      ? String(Boolean(current))
      : field.type === "int"
        ? String(Number(current))
        : String(current);

  const flag = field.type === "string" ? "--set-string" : "--set";
  return `${flag} ${shellQuote(`${field.path}=${helmEscape(value)}`)}`;
}

/**
 * Two flags per pair, addressed by position: extraEnv[0].name, extraEnv[0].value.
 * Both go through --set-string, so a value that looks like a number ("8080")
 * still reaches the pod spec as the string the env var has to be.
 */
function extraEnvFlags(entries) {
  return entries.flatMap((entry, index) =>
    ["name", "value"].map(
      (key) =>
        `--set-string ${shellQuote(`${EXTRA_ENV_PATH}[${index}].${key}=${helmEscape(entry[key])}`)}`,
    ),
  );
}

function buildHelmCommand(chartRepo, split) {
  const alias = repoAlias();
  // Pinned even on "latest": the command should install the version whose values
  // the form is showing, not whatever the repo happens to resolve to later.
  const version = normalizedVersion() || state.entry?.version || "";
  const name = state.releaseName || DEFAULT_RELEASE_NAME;
  const chart = `${alias}/${data.index.chart}`;
  const action = currentAction();

  const command = [
    action.id === "install" ? `helm upgrade --install ${name} ${chart}` : `helm upgrade ${name} ${chart}`,
    `--namespace ${state.namespace || DEFAULT_NAMESPACE}`,
    ...action.flags,
  ];

  if (version) command.push(`--version ${version}`);
  if (channelFor(state.distribution, state.versionType)?.devel) command.push("--devel");
  if (needsValuesFile(split)) command.push("--values values.yaml");
  split.set.forEach((field) => command.push(setFlag(field)));
  command.push(...extraEnvFlags(split.setEnv));

  return [
    `helm repo add ${alias} ${chartRepo}`,
    "helm repo update",
    "",
    command.join(" \\\n  "),
  ].join("\n");
}

function setCode(node, text, emptyText) {
  const isEmpty = !text;
  node.textContent = isEmpty ? emptyText : text;
  node.classList.toggle("is-empty", isEmpty);
}

function renderOutput() {
  const channel = channelFor(state.distribution, state.versionType);
  scheduleUrlUpdate();

  if (!channel) {
    setCode(el.chartRepo, "", "No chart repo published for this combination.");
    setCode(el.helmCommand, "", "Pick an available distribution and version type.");
    setCode(el.valuesYaml, "", "# nothing to generate");
    return;
  }

  const fields = changedFields();
  const split = splitValues(fields, extraEnvEntries());

  setCode(el.chartRepo, channel.repo, "");
  setCode(el.helmCommand, buildHelmCommand(channel.repo, split), "");
  setCode(
    el.valuesYaml,
    needsValuesFile(split) ? buildValuesYaml(split.file, split.fileEnv) : "",
    state.valuesMode === "set" && (split.set.length || split.setEnv.length)
      ? "# nothing to write — the values are passed with --set on the command"
      : "# no custom values yet — the chart defaults are used",
  );

  el.valuesModeHint.textContent = valuesModeHint(split);
}

function valuesModeHint(split) {
  if (state.valuesMode !== "set") {
    return "Changed values are written to values.yaml and the command passes --values values.yaml.";
  }
  if (split.file.length) {
    const paths = split.file.map((field) => field.path).join(", ");
    return `--set takes scalars only, so ${paths} stay${split.file.length === 1 ? "s" : ""} in values.yaml; the rest are flags on the command.`;
  }
  return "Changed values are passed as --set flags, so no file is needed.";
}

/* --------------------------------------------------------------------- *
 * URL state: the current configuration is shareable as a link.
 * --------------------------------------------------------------------- */

/**
 * Overrides arrive from the URL as strings, but bool fields are stored as real
 * booleans (`Boolean("false")` is true). Re-type them against the chart in view.
 */
function normalizeOverrides() {
  const byPath = new Map(buildFields().map((field) => [field.path, field]));

  Object.keys(state.overrides).forEach((path) => {
    const field = byPath.get(path);
    if (!field) return;
    const value = state.overrides[path];

    if (field.type === "bool") state.overrides[path] = String(value) === "true";
    else if (typeof value !== "string") state.overrides[path] = String(value);
  });
}

function readUrlIntoState() {
  const params = new URLSearchParams(window.location.search);

  const distribution = params.get(URL_KEYS.distribution);
  if (distribution && distributionFor(distribution)) state.distribution = distribution;

  const versionType = params.get(URL_KEYS.versionType);
  if (versionType && isAvailable(state.distribution, versionType)) state.versionType = versionType;

  // A hand-edited URL can name a pair that was never published (community + head).
  if (!isAvailable(state.distribution, state.versionType)) {
    state.versionType = versionTypes().find((channel) =>
      isAvailable(state.distribution, channel.id),
    )?.id;
  }

  ["version", "releaseName", "namespace"].forEach((key) => {
    const value = params.get(URL_KEYS[key]);
    if (value !== null) state[key] = value;
  });
  state.custom = false;

  const action = params.get(URL_KEYS.action);
  state.action = ACTIONS.some((item) => item.id === action) ? action : DEFAULT_ACTION;

  const valuesMode = params.get(URL_KEYS.valuesMode);
  state.valuesMode = VALUES_MODES.some((mode) => mode.id === valuesMode)
    ? valuesMode
    : DEFAULT_VALUES_MODE;

  // The playground's own defaults are the baseline; the link edits them.
  state.overrides = seedOverrides();
  params.forEach((value, key) => {
    if (key.startsWith(OVERRIDE_PREFIX)) state.overrides[key.slice(OVERRIDE_PREFIX.length)] = value;
  });

  state.extraEnv = params.getAll(URL_KEYS.extraEnv).map((pair) => {
    // Only the first "=" separates them; a value is free to contain more.
    const cut = pair.indexOf("=");
    return cut === -1
      ? { name: pair, value: "" }
      : { name: pair.slice(0, cut), value: pair.slice(cut + 1) };
  });

  el.version.value = state.version;
  el.releaseName.value = state.releaseName;
  el.namespace.value = state.namespace;
}

/**
 * Only values that differ from what the page starts with are written to the
 * URL — including a playground default that was edited back to the chart's own,
 * which is the one case where "same as the chart" is still a deliberate choice.
 */
function currentUrl() {
  const params = new URLSearchParams();
  params.set(URL_KEYS.distribution, state.distribution);
  params.set(URL_KEYS.versionType, state.versionType);

  if (state.version.trim()) params.set(URL_KEYS.version, state.version.trim());
  if (state.releaseName !== DEFAULT_RELEASE_NAME) params.set(URL_KEYS.releaseName, state.releaseName);
  if (state.namespace !== DEFAULT_NAMESPACE) params.set(URL_KEYS.namespace, state.namespace);
  if (state.action !== DEFAULT_ACTION) params.set(URL_KEYS.action, state.action);
  if (state.valuesMode !== DEFAULT_VALUES_MODE) params.set(URL_KEYS.valuesMode, state.valuesMode);

  buildFields()
    .filter(isEdited)
    .forEach((field) => params.set(OVERRIDE_PREFIX + field.path, String(fieldValue(field))));

  extraEnvEntries().forEach((entry) => {
    params.append(URL_KEYS.extraEnv, `${entry.name}=${entry.value}`);
  });

  const query = params.toString();
  return `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
}

function writeUrl() {
  try {
    window.history.replaceState(null, "", currentUrl());
  } catch {
    // Browsers reject history updates on file:// — the page still works, just without a shareable URL.
  }
}

let urlTimer;
function scheduleUrlUpdate() {
  clearTimeout(urlTimer);
  urlTimer = setTimeout(writeUrl, 250);
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

function showError(error) {
  el.banner.hidden = false;
  el.banner.textContent =
    window.location.protocol === "file:"
      ? "The chart data is loaded with fetch, which browsers block on file:// — serve the folder over http (npx serve .) and reload."
      : `Could not load the chart data: ${error.message}`;
}

/** Loads whatever the current selection needs, then redraws. */
async function update() {
  document.body.dataset.busy = "true";
  try {
    await refreshChart();
    await renderForm();
    renderOutput();
    el.banner.hidden = true;
  } catch (error) {
    showError(error);
  } finally {
    delete document.body.dataset.busy;
  }
}

function bindEvents() {
  el.versionSelect.addEventListener("change", () => selectVersion(el.versionSelect.value));

  // Typing a version only changes which values are shown when it turns out to
  // be one the repo publishes, so the form does not flicker mid-word.
  let typing;
  el.version.addEventListener("input", () => {
    state.version = el.version.value;
    renderOutput();
    clearTimeout(typing);
    typing = setTimeout(update, 400);
  });

  bindInput(el.releaseName, "releaseName");
  bindInput(el.namespace, "namespace");
  bindCopyButtons();

  // The input lives outside the containers renderValuesFields replaces, so
  // filtering as you type does not cost the field its focus.
  el.valuesSearch.addEventListener("input", () => {
    state.search = el.valuesSearch.value;
    renderValuesFields();
  });

  el.resetValues.addEventListener("click", () => {
    state.overrides = seedOverrides();
    renderValuesFields();
    renderOutput();
  });

  el.addExtraEnv.addEventListener("click", () => {
    state.extraEnv.push({ name: "", value: "" });
    renderExtraEnv();
    el.extraEnv.querySelector(".env-row:last-of-type input")?.focus();
    renderOutput();
  });

  el.copyLink.addEventListener("click", async () => {
    writeUrl();
    const copied = await copyText(window.location.href);
    el.copyLink.textContent = copied ? "Copied" : "Failed";
    setTimeout(() => {
      el.copyLink.textContent = "Copy link";
    }, 1500);
  });

  // Someone edited the address bar or used back/forward.
  window.addEventListener("popstate", () => {
    readUrlIntoState();
    update();
  });
}

async function init() {
  try {
    data.index = await loadJson("index.json");
  } catch (error) {
    showError(error);
    return;
  }

  state.distribution = distributionFor(DEFAULT_SELECTION.distribution)
    ? DEFAULT_SELECTION.distribution
    : distributions()[0].id;
  state.versionType = isAvailable(state.distribution, DEFAULT_SELECTION.versionType)
    ? DEFAULT_SELECTION.versionType
    : versionTypes().find((channel) => isAvailable(state.distribution, channel.id))?.id;
  state.releaseName = el.releaseName.value;
  state.namespace = el.namespace.value;
  readUrlIntoState();

  bindEvents();
  await update();
}

init();
