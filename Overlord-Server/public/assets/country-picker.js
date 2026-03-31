// Country data: code -> [name, continent]
const COUNTRIES = {
  AF: ["Afghanistan", "Asia"],
  AL: ["Albania", "Europe"],
  DZ: ["Algeria", "Africa"],
  AD: ["Andorra", "Europe"],
  AO: ["Angola", "Africa"],
  AG: ["Antigua & Barbuda", "North America"],
  AR: ["Argentina", "South America"],
  AM: ["Armenia", "Asia"],
  AU: ["Australia", "Oceania"],
  AT: ["Austria", "Europe"],
  AZ: ["Azerbaijan", "Asia"],
  BS: ["Bahamas", "North America"],
  BH: ["Bahrain", "Asia"],
  BD: ["Bangladesh", "Asia"],
  BB: ["Barbados", "North America"],
  BY: ["Belarus", "Europe"],
  BE: ["Belgium", "Europe"],
  BZ: ["Belize", "North America"],
  BJ: ["Benin", "Africa"],
  BT: ["Bhutan", "Asia"],
  BO: ["Bolivia", "South America"],
  BA: ["Bosnia & Herzegovina", "Europe"],
  BW: ["Botswana", "Africa"],
  BR: ["Brazil", "South America"],
  BN: ["Brunei", "Asia"],
  BG: ["Bulgaria", "Europe"],
  BF: ["Burkina Faso", "Africa"],
  BI: ["Burundi", "Africa"],
  CV: ["Cabo Verde", "Africa"],
  KH: ["Cambodia", "Asia"],
  CM: ["Cameroon", "Africa"],
  CA: ["Canada", "North America"],
  CF: ["Central African Republic", "Africa"],
  TD: ["Chad", "Africa"],
  CL: ["Chile", "South America"],
  CN: ["China", "Asia"],
  CO: ["Colombia", "South America"],
  KM: ["Comoros", "Africa"],
  CG: ["Congo", "Africa"],
  CD: ["Congo (DR)", "Africa"],
  CR: ["Costa Rica", "North America"],
  HR: ["Croatia", "Europe"],
  CU: ["Cuba", "North America"],
  CY: ["Cyprus", "Europe"],
  CZ: ["Czechia", "Europe"],
  DK: ["Denmark", "Europe"],
  DJ: ["Djibouti", "Africa"],
  DM: ["Dominica", "North America"],
  DO: ["Dominican Republic", "North America"],
  EC: ["Ecuador", "South America"],
  EG: ["Egypt", "Africa"],
  SV: ["El Salvador", "North America"],
  GQ: ["Equatorial Guinea", "Africa"],
  ER: ["Eritrea", "Africa"],
  EE: ["Estonia", "Europe"],
  SZ: ["Eswatini", "Africa"],
  ET: ["Ethiopia", "Africa"],
  FJ: ["Fiji", "Oceania"],
  FI: ["Finland", "Europe"],
  FR: ["France", "Europe"],
  GA: ["Gabon", "Africa"],
  GM: ["Gambia", "Africa"],
  GE: ["Georgia", "Asia"],
  DE: ["Germany", "Europe"],
  GH: ["Ghana", "Africa"],
  GR: ["Greece", "Europe"],
  GD: ["Grenada", "North America"],
  GT: ["Guatemala", "North America"],
  GN: ["Guinea", "Africa"],
  GW: ["Guinea-Bissau", "Africa"],
  GY: ["Guyana", "South America"],
  HT: ["Haiti", "North America"],
  HN: ["Honduras", "North America"],
  HU: ["Hungary", "Europe"],
  IS: ["Iceland", "Europe"],
  IN: ["India", "Asia"],
  ID: ["Indonesia", "Asia"],
  IR: ["Iran", "Asia"],
  IQ: ["Iraq", "Asia"],
  IE: ["Ireland", "Europe"],
  IL: ["Israel", "Asia"],
  IT: ["Italy", "Europe"],
  JM: ["Jamaica", "North America"],
  JP: ["Japan", "Asia"],
  JO: ["Jordan", "Asia"],
  KZ: ["Kazakhstan", "Asia"],
  KE: ["Kenya", "Africa"],
  KI: ["Kiribati", "Oceania"],
  KP: ["North Korea", "Asia"],
  KR: ["South Korea", "Asia"],
  KW: ["Kuwait", "Asia"],
  KG: ["Kyrgyzstan", "Asia"],
  LA: ["Laos", "Asia"],
  LV: ["Latvia", "Europe"],
  LB: ["Lebanon", "Asia"],
  LS: ["Lesotho", "Africa"],
  LR: ["Liberia", "Africa"],
  LY: ["Libya", "Africa"],
  LI: ["Liechtenstein", "Europe"],
  LT: ["Lithuania", "Europe"],
  LU: ["Luxembourg", "Europe"],
  MO: ["Macao", "Asia"],
  MG: ["Madagascar", "Africa"],
  MW: ["Malawi", "Africa"],
  MY: ["Malaysia", "Asia"],
  MV: ["Maldives", "Asia"],
  ML: ["Mali", "Africa"],
  MT: ["Malta", "Europe"],
  MH: ["Marshall Islands", "Oceania"],
  MR: ["Mauritania", "Africa"],
  MU: ["Mauritius", "Africa"],
  MX: ["Mexico", "North America"],
  FM: ["Micronesia", "Oceania"],
  MD: ["Moldova", "Europe"],
  MC: ["Monaco", "Europe"],
  MN: ["Mongolia", "Asia"],
  ME: ["Montenegro", "Europe"],
  MA: ["Morocco", "Africa"],
  MZ: ["Mozambique", "Africa"],
  MM: ["Myanmar", "Asia"],
  NA: ["Namibia", "Africa"],
  NR: ["Nauru", "Oceania"],
  NP: ["Nepal", "Asia"],
  NL: ["Netherlands", "Europe"],
  NZ: ["New Zealand", "Oceania"],
  NI: ["Nicaragua", "North America"],
  NE: ["Niger", "Africa"],
  NG: ["Nigeria", "Africa"],
  MK: ["North Macedonia", "Europe"],
  NO: ["Norway", "Europe"],
  OM: ["Oman", "Asia"],
  PK: ["Pakistan", "Asia"],
  PW: ["Palau", "Oceania"],
  PS: ["Palestine", "Asia"],
  PA: ["Panama", "North America"],
  PG: ["Papua New Guinea", "Oceania"],
  PY: ["Paraguay", "South America"],
  PE: ["Peru", "South America"],
  PH: ["Philippines", "Asia"],
  PL: ["Poland", "Europe"],
  PT: ["Portugal", "Europe"],
  QA: ["Qatar", "Asia"],
  RO: ["Romania", "Europe"],
  RU: ["Russia", "Europe"],
  RW: ["Rwanda", "Africa"],
  KN: ["Saint Kitts & Nevis", "North America"],
  LC: ["Saint Lucia", "North America"],
  VC: ["Saint Vincent & Grenadines", "North America"],
  WS: ["Samoa", "Oceania"],
  SM: ["San Marino", "Europe"],
  ST: ["São Tomé & Príncipe", "Africa"],
  SA: ["Saudi Arabia", "Asia"],
  SN: ["Senegal", "Africa"],
  RS: ["Serbia", "Europe"],
  SC: ["Seychelles", "Africa"],
  SL: ["Sierra Leone", "Africa"],
  SG: ["Singapore", "Asia"],
  SK: ["Slovakia", "Europe"],
  SI: ["Slovenia", "Europe"],
  SB: ["Solomon Islands", "Oceania"],
  SO: ["Somalia", "Africa"],
  ZA: ["South Africa", "Africa"],
  SS: ["South Sudan", "Africa"],
  ES: ["Spain", "Europe"],
  LK: ["Sri Lanka", "Asia"],
  SD: ["Sudan", "Africa"],
  SR: ["Suriname", "South America"],
  SE: ["Sweden", "Europe"],
  CH: ["Switzerland", "Europe"],
  SY: ["Syria", "Asia"],
  TW: ["Taiwan", "Asia"],
  TJ: ["Tajikistan", "Asia"],
  TZ: ["Tanzania", "Africa"],
  TH: ["Thailand", "Asia"],
  TL: ["Timor-Leste", "Asia"],
  TG: ["Togo", "Africa"],
  TO: ["Tonga", "Oceania"],
  TT: ["Trinidad & Tobago", "North America"],
  TN: ["Tunisia", "Africa"],
  TR: ["Turkey", "Asia"],
  TM: ["Turkmenistan", "Asia"],
  TV: ["Tuvalu", "Oceania"],
  UG: ["Uganda", "Africa"],
  UA: ["Ukraine", "Europe"],
  AE: ["United Arab Emirates", "Asia"],
  GB: ["United Kingdom", "Europe"],
  US: ["United States", "North America"],
  UY: ["Uruguay", "South America"],
  UZ: ["Uzbekistan", "Asia"],
  VU: ["Vanuatu", "Oceania"],
  VE: ["Venezuela", "South America"],
  VN: ["Vietnam", "Asia"],
  YE: ["Yemen", "Asia"],
  ZM: ["Zambia", "Africa"],
  ZW: ["Zimbabwe", "Africa"],
};

const CONTINENT_ORDER = [
  "North America",
  "South America",
  "Europe",
  "Africa",
  "Asia",
  "Oceania",
];

function flagHtml(code) {
  if (!code) return "";
  const cc = String(code).toLowerCase();
  if (!/^[a-z]{2}$/.test(cc) || cc === "zz") return "🏴";
  return `<span class="fi fi-${cc}"></span>`;
}

export function initCountryPicker(onSelect, initialCode = "all") {
  const anchor = document.getElementById("country-picker-anchor");
  if (!anchor) return;

  let currentCode = initialCode;
  let countryData = []; // [{ code, count }]
  let panelOpen = false;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "country-picker-btn";
  btn.className =
    "inline-flex items-center gap-2 bg-slate-900/70 border border-slate-800 rounded-lg px-3 py-2 text-slate-100 hover:border-slate-600 transition-colors";
  const initialFlag = initialCode !== "all" ? flagHtml(initialCode) : "";
  const initialName = initialCode !== "all" && COUNTRIES[initialCode] ? COUNTRIES[initialCode][0] : "All Countries";
  const initialLabelHtml = initialCode !== "all" ? `${initialFlag}&nbsp;${initialName}` : "All Countries";
  btn.innerHTML = `<i class="fa-solid fa-earth-americas text-slate-400"></i><span id="country-picker-label">${initialLabelHtml}</span><i class="fa-solid fa-chevron-down text-slate-400 text-xs"></i>`;
  anchor.appendChild(btn);

  const panel = document.createElement("div");
  panel.id = "country-picker-panel";
  panel.className =
    "hidden absolute z-[9999] mt-1 w-72 rounded-xl border border-slate-700 bg-slate-900 shadow-2xl flex flex-col overflow-hidden";
  panel.style.maxHeight = "420px";

  const searchWrap = document.createElement("div");
  searchWrap.className = "p-2 border-b border-slate-800 flex-shrink-0";
  searchWrap.innerHTML = `<div class="flex items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5"><i class="fa-solid fa-magnifying-glass text-slate-400 text-xs"></i><input id="country-search" type="search" placeholder="Search country..." class="bg-transparent outline-none text-sm text-slate-100 placeholder:text-slate-500 w-full"></div>`;
  panel.appendChild(searchWrap);

  const list = document.createElement("div");
  list.className = "overflow-y-auto flex-1";
  panel.appendChild(list);

  document.body.appendChild(panel);

  function positionPanel() {
    const rect = btn.getBoundingClientRect();
    panel.style.top = `${rect.bottom + window.scrollY + 4}px`;
    panel.style.left = `${rect.left + window.scrollX}px`;
  }

  function openPanel() {
    panelOpen = true;
    panel.classList.remove("hidden");
    positionPanel();
    setTimeout(() => {
      const inp = panel.querySelector("#country-search");
      if (inp) inp.focus();
    }, 0);
  }

  function closePanel() {
    panelOpen = false;
    panel.classList.add("hidden");
    const inp = panel.querySelector("#country-search");
    if (inp) inp.value = "";
    renderList("");
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (panelOpen) {
      closePanel();
    } else {
      openPanel();
    }
  });

  document.addEventListener("click", (e) => {
    if (!panelOpen) return;
    if (!panel.contains(e.target) && e.target !== btn) {
      closePanel();
    }
  });

  window.addEventListener("resize", () => {
    if (panelOpen) positionPanel();
  });

  const searchInput = searchWrap.querySelector("#country-search");
  searchInput.addEventListener("input", (e) => {
    renderList(e.target.value.trim().toLowerCase());
  });

  function setSelected(code, label, flagMarkup) {
    currentCode = code;
    const labelEl = document.getElementById("country-picker-label");
    if (labelEl) {
      if (code === "all") {
        labelEl.innerHTML = "All Countries";
      } else {
        labelEl.innerHTML = `${flagMarkup}&nbsp;${label}`;
      }
    }
    onSelect(code);
    closePanel();
  }

  function renderList(query) {
    list.innerHTML = "";

    const presentCodes = new Set(countryData.map((d) => d.code));
    const countMap = Object.fromEntries(countryData.map((d) => [d.code, d.count]));

    const allItem = makeItem(
      `<i class="fa-solid fa-earth-americas text-slate-400"></i>`,
      "All Countries",
      "",
      "all",
      null,
      currentCode === "all",
    );
    if (!query) list.appendChild(allItem);

    const continentGroups = {};

    for (const code of presentCodes) {
      if (code === "ZZ") continue;
      const info = COUNTRIES[code];
      const name = info ? info[0] : code;
      const continent = info ? info[1] : "Other";

      if (query && !name.toLowerCase().includes(query) && !code.toLowerCase().includes(query)) continue;

      if (!continentGroups[continent]) continentGroups[continent] = [];
      continentGroups[continent].push({ code, name, count: countMap[code] || 0 });
    }

    const continentKeys = Object.keys(continentGroups).sort((a, b) => {
      const ai = CONTINENT_ORDER.indexOf(a);
      const bi = CONTINENT_ORDER.indexOf(b);
      if (ai === -1 && bi === -1) return a.localeCompare(b);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });

    for (const continent of continentKeys) {
      const countries = continentGroups[continent].sort((a, b) =>
        a.name.localeCompare(b.name),
      );

      const header = document.createElement("div");
      header.className = "px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500 bg-slate-950/50 sticky top-0";
      header.textContent = continent;
      list.appendChild(header);

      for (const { code, name, count } of countries) {
        const flag = flagHtml(code);
        const item = makeItem(flag, name, code, code, count, currentCode === code);
        list.appendChild(item);
      }
    }

    if (list.children.length === 0 || (list.children.length === 1 && !query)) {
      const empty = document.createElement("div");
      empty.className = "px-4 py-6 text-center text-slate-500 text-sm";
      empty.textContent = query ? "No matching countries" : "No country data yet";
      list.appendChild(empty);
    }
  }

  function makeItem(flagMarkup, name, code, value, count, active) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = `w-full text-left flex items-center gap-3 px-3 py-2 text-sm hover:bg-slate-800 transition-colors ${active ? "bg-slate-800/80 text-blue-300" : "text-slate-200"}`;

    const flagSpan = document.createElement("span");
    flagSpan.className = "w-6 text-center flex-shrink-0 text-base";
    flagSpan.innerHTML = flagMarkup;

    const nameSpan = document.createElement("span");
    nameSpan.className = "flex-1 truncate";
    nameSpan.textContent = name;

    el.appendChild(flagSpan);
    el.appendChild(nameSpan);

    if (count !== null) {
      const badge = document.createElement("span");
      badge.className = "text-xs text-slate-400 font-mono flex-shrink-0";
      badge.textContent = count;
      el.appendChild(badge);
    }

    el.addEventListener("click", () => setSelected(value, name, flagMarkup));
    return el;
  }

  async function loadCountries() {
    try {
      const res = await fetch("/api/clients/countries");
      if (!res.ok) return;
      const data = await res.json();
      countryData = Array.isArray(data.countries) ? data.countries : [];
      renderList("");
    } catch (err) {
      console.error("country-picker: failed to load countries", err);
    }
  }

  loadCountries();
  setInterval(loadCountries, 30000);

  renderList("");
}
