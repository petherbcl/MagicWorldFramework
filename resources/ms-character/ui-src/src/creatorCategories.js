// Static category → tab mapping of the creator (plan §5.3.1 / STORY-05.11) and the helpers that read the schema
// and the CreatorState. The runtime schema (docs/ms-character-runtime-findings.md §2.1) only knows category IDs
// and option IDs, so every pt-PT label, icon, component and camera framing lives here.

export const BODY_PREFIX = Object.freeze({ female: "BodyFemale", male: "BodyMale" });
export const FEMALE_HIDDEN = "Os pelos faciais só estão disponíveis com o corpo masculino.";

// control: "grid" (OptionGrid) | "slider" (StepSlider); none: UI-added first tile "Nenhum" (id ""), not part of the schema.
// maleOnly: hidden with the female body (facial hair; marking3 is also absent from the female schema).
export const CATEGORIES = Object.freeze({
  preset: { title: "Predefinição", control: "grid" },
  faceShape: { title: "Forma do rosto", control: "grid" },
  skin: { title: "Tom de pele", control: "slider" },
  hairStyle: { title: "Penteado", control: "grid" },
  hairColour: { title: "Cor do cabelo", control: "slider" },
  eyeColour: { title: "Cor dos olhos", control: "slider" },
  browShape: { title: "Forma das sobrancelhas", control: "grid" },
  browColour: { title: "Cor das sobrancelhas", control: "slider" },
  marking0: { title: "Sardas e Sinais", control: "grid" },
  marking1: { title: "Rosáceas", control: "grid" },
  marking2: { title: "Cicatrizes", control: "grid" },
  marking3: { title: "Maquilhagem", control: "grid", maleOnly: true },
  glasses: { title: "Óculos", control: "grid", none: true },
  facialHair: { title: "Pelos faciais", control: "grid", none: true, maleOnly: true },
  facialHairColor: { title: "Cor dos pelos faciais", control: "slider", maleOnly: true },
});

// `icon` is a key of components/icons/categoryIcons.js; `framing` is what camera:frame sends when the tab opens.
export const TABS = Object.freeze([
  { key: "body", label: "Corpo", icon: "body", framing: "body", categories: [] }, // body type + pronoun + "preset" are built by the creator
  { key: "face", label: "Rosto", icon: "face", framing: "face", categories: ["faceShape", "skin"] },
  { key: "hair", label: "Cabelo", icon: "hair", framing: "face", categories: ["hairColour", "hairStyle"] },
  { key: "eyes", label: "Olhos e sobrancelhas", icon: "eyes", framing: "face", categories: ["eyeColour", "browShape", "browColour"] },
  { key: "marks", label: "Marcas", icon: "marks", framing: "face", categories: ["marking0", "marking1", "marking2", "marking3"] },
  { key: "facewear", label: "Acessórios", icon: "facewear", framing: "face", categories: ["glasses", "facialHair", "facialHairColor"] },
  { key: "finalise", label: "Finalizar", icon: "finalise", framing: "body", categories: [] }, // name and house (STORY-05.12)
]);

const KNOWN = new Set(["preset", ...Object.keys(CATEGORIES)]);
const FINALISE = TABS.length - 1;

// CreatorState keeps three categories outside `selections` (CreatorState in the API reference).
const TOP_LEVEL = Object.freeze({ glasses: "faceGear", facialHair: "facialHair", facialHairColor: "facialHairColor" });

// Flat { categoryId: optionId } view of a CreatorState.
export function toValues(state) {
  const values = { ...(state && typeof state.selections === "object" && state.selections ? state.selections : {}) };
  for (const [category, field] of Object.entries(TOP_LEVEL)) {
    if (state && typeof state[field] === "string") values[category] = state[field];
  }
  return values;
}

// "female" | "male" from the selected preset, or null when it is not a BodyFemale…/BodyMale… ID.
export function bodyOf(preset) {
  if (typeof preset !== "string") return null;
  if (preset.startsWith(BODY_PREFIX.female)) return "female";
  if (preset.startsWith(BODY_PREFIX.male)) return "male";
  return null;
}

// First preset ID of a body: what creator:body sends. Undefined when the schema has none.
export const firstBodyPreset = (presets, body) => (presets || []).find(id => typeof id === "string" && id.startsWith(BODY_PREFIX[body]));

// "Predefinição" options: only the presets of the current body (15 each); every preset while the body is unknown.
export const presetsOfBody = (presets, body) => (body ? (presets || []).filter(id => id.startsWith(BODY_PREFIX[body])) : presets || []);

// The tabs for a schema ({ categoryId: options[] } or null while it has not arrived): the 7 static tabs, each with the
// groups it shows now, plus one tab per unknown schema category (generic icon, the ID as label) before "Finalizar".
export function buildTabs(categories, body) {
  const known = TABS.map(tab => ({
    ...tab,
    groups: tab.categories.filter(id => categories && Array.isArray(categories[id]) && !(body === "female" && CATEGORIES[id].maleOnly)),
  }));
  const unknown = Object.keys(categories || {}).filter(id => !KNOWN.has(id) && Array.isArray(categories[id])).map(id => ({
    key: `x-${id.replace(/[^\w-]/g, "_")}`, label: "Outras opções", icon: "generic", framing: "face", categories: [id], groups: [id], unknown: true,
  }));
  return [...known.slice(0, FINALISE), ...unknown, known[FINALISE]];
}

export const groupConfig = id => CATEGORIES[id] || { title: "Outras opções", control: "grid" };
