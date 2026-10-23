// @ts-check
/// <reference path="./kino.d.ts" />
// MultiCine (EXPERIMENT, spec 2026-10-22): one plugin over the Nuvio scrapers the person already installed from a repo.
// The titles come from Kino's own TMDB access (kino.tmdb, kino.meta); the video comes from kino.nuvio, which asks each installed
// scraper of the repo (with the importer's own hosts, torrent filter and limits) and hands back what it found. This file only
// sorts, merges and labels those copies. It runs nothing downloaded and knows nothing about any scraper or site.
// Read it top to bottom: 1. texts  2. helpers  3. TMDB, titles and rows  4. streams  5. settings

// ---- 1. texts ----------------------------------------------------------------------------------------------------

const TEXTS = {
  es: {
    noTmdb: "No se pudo consultar el catálogo de títulos. Revisa tu conexión.",
    noImdb: "Este título no tiene el identificador que se necesita.",
    noEpisodes: "No se encontraron episodios para esta serie.",
    unknownRef: "Referencia desconocida.",
    noScrapers: "No se pudo preparar ningún scraper de este repositorio. Revisa tu conexión.",
    noSources: "Ningún scraper encontró fuentes para este título ({asked} consultados).",
    preparing: "Preparando los scrapers del repositorio. Inténtalo de nuevo en unos segundos.",
    noSourcesWhy: "Ningún scraper encontró fuentes ({n} probados): {list}.",
    whyDown: "sitio caído",
    whyError: "error del sitio",
    whyNone: "sin resultados",
    whyTimeout: "tiempo agotado",
    whyOther: "falló",
    shortClip: "Esa copia dura solo {n} s: es un clip y no la película. Prueba otra en el menú Servidor.",
    ok: "Listos {n} scrapers de este repositorio.",
    offline: "Sin comprobar: {detail}",
    cinema: "Cine",
    series: "Series",
    trending: "Tendencias",
    popular: "Populares",
    topRated: "Mejor valoradas",
    nowPlaying: "En cartelera",
    onAir: "Al aire ahora",
  },
  en: {
    noTmdb: "Could not reach the title catalog. Check your connection.",
    noImdb: "This title has no identifier that is needed.",
    noEpisodes: "No episodes were found for this series.",
    unknownRef: "Unknown reference.",
    noScrapers: "No scraper of this repository could be prepared. Check your connection.",
    noSources: "No scraper found sources for this title ({asked} asked).",
    preparing: "Preparing the repository's scrapers. Try again in a few seconds.",
    noSourcesWhy: "No scraper found sources ({n} tried): {list}.",
    whyDown: "site down",
    whyError: "site error",
    whyNone: "no results",
    whyTimeout: "timed out",
    whyOther: "failed",
    shortClip: "That copy lasts only {n} s: it is a clip, not the title. Try another in the Server menu.",
    ok: "{n} scrapers of this repository are ready.",
    offline: "Not checked: {detail}",
    cinema: "Movies",
    series: "Series",
    trending: "Trending",
    popular: "Popular",
    topRated: "Top rated",
    nowPlaying: "In theaters",
    onAir: "On the air",
  },
};

function t(key, vars) {
  const lang = String(kino.lang || "").toLowerCase().startsWith("es") ? "es" : "en";
  const tpl = TEXTS[lang][key] || TEXTS.es[key] || key;
  return vars ? tpl.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] != null ? vars[k] : "")) : tpl;
}

// ---- 2. helpers --------------------------------------------------------------------------------------------------

function enc(s) {
  return encodeURIComponent(String(s));
}

/** Runs `fn` over `list` with at most `limit` in flight; a failed item answers undefined. */
async function pool(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      try { out[i] = await fn(list[i], i); } catch { out[i] = undefined; }
    }
  };
  const workers = [];
  for (let w = 0; w < Math.min(limit, list.length); w++) workers.push(worker());
  await Promise.all(workers);
  return out;
}

const MEM = new Map();
const TTL_PAGE = 10 * 60 * 1000;

async function cachedMem(key, ttl, fn) {
  const hit = MEM.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.v;
  const v = await fn();
  MEM.set(key, { at: Date.now(), v });
  return v;
}

/** A value kept in storage for `ttl` ms; `make` runs when it is missing or stale, and a failure keeps nothing. */
async function stored(key, ttl, make) {
  try {
    const raw = kino.storage.get(key);
    if (raw) {
      const e = JSON.parse(raw);
      if (e && typeof e.at === "number" && Date.now() - e.at < ttl) return e.v;
    }
  } catch { /* unreadable: ask again */ }
  const v = await make();
  try { kino.storage.set(key, JSON.stringify({ at: Date.now(), v })); } catch { /* storage full: not cached */ }
  return v;
}


// ---- 3. TMDB -----------------------------------------------------------------------------------------------------

function tmdbLang() {
  return String(kino.lang || "").toLowerCase().startsWith("es") ? "es-MX" : "en-US";
}

// Kino answers a plugin at most 20 TMDB calls per 10 s on its own key (more only on the person's), and Home, the section
// and Categorías are asked together when the app opens. Every call takes a slot here, so the burst waits its turn
// instead of being refused.
const TMDB_WINDOW_MS = 10000;
const TMDB_MAX_IN_WINDOW = 16;
const TMDB_CALLS = [];

async function tmdbSlot() {
  for (;;) {
    const now = Date.now();
    while (TMDB_CALLS.length && now - TMDB_CALLS[0] >= TMDB_WINDOW_MS) TMDB_CALLS.shift();
    if (TMDB_CALLS.length < TMDB_MAX_IN_WINDOW) {
      TMDB_CALLS.push(now);
      return;
    }
    await kino.sleep(Math.min(5000, TMDB_WINDOW_MS - (now - TMDB_CALLS[0]) + 50));
  }
}

/** A GET to TMDB through Kino (no key here): cached in memory for the sandbox's life. */
async function tmdb(path, params) {
  if (typeof kino.tmdb !== "function") throw kino.error("unavailable", "no kino.tmdb", { userMessage: t("noTmdb") });
  const query = Object.assign({ language: tmdbLang() }, params || {});
  try {
    return await cachedMem(path + "?" + JSON.stringify(query), TTL_PAGE, async () => {
      await tmdbSlot();
      return kino.tmdb(path, query);
    });
  } catch (e) {
    const code = e && e.code;
    kino.log("tmdb " + path.split("/").slice(0, 3).join("/") + " failed: " + code);
    if (code === "not_found") throw kino.error("not_found", "tmdb not found", { userMessage: t("unknownRef") });
    throw kino.error("unavailable", "tmdb " + code, { userMessage: (e && e.userMessage) || t("noTmdb") });
  }
}

const TTL_GENRES = 24 * 60 * 60 * 1000;

/** TMDB's genre names by id, for movies and for series, in the person's language. */
async function genreNames() {
  return stored("g1-" + tmdbLang(), TTL_GENRES, async () => {
    const [movie, tv] = await Promise.all([tmdb("/genre/movie/list"), tmdb("/genre/tv/list")]);
    const map = (d) => Object.fromEntries(((d && d.genres) || []).map((g) => [g.id, String(g.name)]));
    return { movie: map(movie), tv: map(tv) };
  });
}

// ---- 3b. titles ---------------------------------------------------------------------------------------------------

function hash(s) {
  let a = 0x811c9dc5;
  let b = 5381;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619) >>> 0;
    b = (Math.imul(b, 33) + c) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

function safeId(raw) {
  return String(raw).replace(/[^A-Za-z0-9._~-]/g, "-").slice(0, 120) || "x";
}

function httpUrl(v) {
  return typeof v === "string" && /^https?:\/\//.test(v) && v.length <= 2048 ? v : undefined;
}

function num(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

const VISUAL = /[\u{1F000}-\u{1FFFF}☀-➿️‍]/gu;
const BLANK = /^[\s⠀​-‍﻿]*$/;

/**
 * A ref is JSON. A title: { k: "movie" | "series", t: TMDB id, m: IMDb id when known }; an episode adds { s, e }; a live
 * channel: { k: "tv", id: the server's id }; a "Ver más" page: { k, e: TMDB endpoint, q: its fixed filters }.
 */
function makeRef(o) {
  return JSON.stringify(o);
}

function parseRef(ref) {
  try {
    const r = JSON.parse(String(ref));
    if (r && typeof r.k === "string") return r;
  } catch { /* falls through */ }
  throw kino.error("not_found", "bad ref", { userMessage: t("unknownRef") });
}

function image(path, size) {
  return typeof path === "string" && path.startsWith("/") ? `https://image.tmdb.org/t/p/${size}${path}` : undefined;
}

/** One TMDB result as a Kino item; `kind` is "movie" or "series". */
function titleItem(r, kind, names) {
  const title = String(kind === "movie" ? r.title || r.original_title : r.name || r.original_name || "").trim();
  if (!r || !r.id || !title) return null;
  const item = { id: (kind === "movie" ? "m" : "s") + r.id, ref: makeRef({ k: kind, t: r.id }), title: title.slice(0, 200), kind, ids: { tmdb: r.id } };
  const date = String((kind === "movie" ? r.release_date : r.first_air_date) || "");
  const y = num(date.slice(0, 4));
  if (y >= 1870 && y <= 2100) item.year = y;
  const poster = image(r.poster_path, "w342");
  if (poster) item.poster = poster;
  const backdrop = image(r.backdrop_path, "w780");
  if (backdrop) item.backdrop = backdrop;
  if (r.overview) item.overview = String(r.overview);
  const original = String(kind === "movie" ? r.original_title || "" : r.original_name || "").trim();
  if (original && original !== title) item.originalTitle = original.slice(0, 200);
  if (r.vote_average > 0) item.rating = Math.round(r.vote_average * 10) / 10;
  const table = (names && names[kind === "movie" ? "movie" : "tv"]) || {};
  const genres = (Array.isArray(r.genre_ids) ? r.genre_ids : []).map((id) => table[id]).filter(Boolean).map((g) => String(g).slice(0, 30)).slice(0, 5);
  if (genres.length) item.genres = genres;
  return item;
}

function itemsOf(results, kind, names) {
  const seen = new Set();
  const items = [];
  for (const r of Array.isArray(results) ? results : []) {
    const item = titleItem(r, kind, names);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  return items;
}

/** What `kino.meta` knows about a title by its TMDB id: the whole of its page, episodes and every id Kino has. */
async function metaOf(kind, tmdbId) {
  if (typeof kino.meta !== "function") throw kino.error("unavailable", "no kino.meta", { userMessage: t("noTmdb") });
  try {
    const answer = await kino.meta({ type: kind, ids: { tmdb: tmdbId } });
    if (!answer) throw kino.error("not_found", "no meta", { userMessage: t("unknownRef") });
    return answer;
  } catch (e) {
    if (e && e.code === "not_found") throw e;
    kino.log("kino.meta failed: " + (e && e.code));
    throw kino.error("unavailable", "meta " + (e && e.code), { userMessage: (e && e.userMessage) || t("noTmdb") });
  }
}

function infoOf(meta) {
  return {
    title: meta.title ? String(meta.title).slice(0, 200) : undefined,
    poster: httpUrl(meta.poster),
    backdrop: httpUrl(meta.backdrop),
    overview: meta.overview ? String(meta.overview) : undefined,
    genres: meta.genres && meta.genres.length ? meta.genres.slice(0, 5) : undefined,
    year: num(meta.year) || undefined,
    ids: meta.ids,
    runtimeMinutes: meta.runtimeMinutes,
  };
}

export async function details(ref) {
  const r = parseRef(ref);
  if (r.k !== "movie" || !r.t) throw kino.error("not_found", "not a movie", { userMessage: t("unknownRef") });
  return infoOf(await metaOf("movie", r.t));
}

export async function episodes(ref) {
  const r = parseRef(ref);
  if (r.k !== "series" || !r.t) throw kino.error("not_found", "not a series", { userMessage: t("unknownRef") });
  const meta = await metaOf("series", r.t);
  const imdb = meta.ids && meta.ids.imdb;
  const list = [];
  for (const ep of Array.isArray(meta.episodes) ? meta.episodes : []) {
    const season = num(ep.season);
    const number = num(ep.number);
    if (season < 1 || season > 999 || number < 1 || number > 99999) continue; // specials (season 0) have no place in Kino's numbering
    const entry = { season, number, ref: makeRef({ k: "series", t: r.t, m: imdb || undefined, s: season, e: number }) };
    if (ep.title) entry.title = String(ep.title).slice(0, 200);
    const still = httpUrl(ep.still);
    if (still) entry.still = still;
    if (ep.overview) entry.overview = String(ep.overview);
    const aired = /^\d{4}-\d{2}-\d{2}/.exec(String(ep.airDate || ""));
    if (aired) entry.airDate = aired[0];
    list.push(entry);
  }
  if (!list.length) throw kino.error("not_found", "no episodes", { userMessage: t("noEpisodes") });
  list.sort((a, b) => (a.season - b.season) || (a.number - b.number));
  return { series: infoOf(meta), episodes: list };
}

// ---- 3c. rows -----------------------------------------------------------------------------------------------------

const ROW_ITEMS = 15;
const DEADLINE_MS = 9000;

/** The TMDB list a row shows: an endpoint of one kind plus fixed filters. `kind` is "movie" or "series". */
function listSpec(kind, title, endpoint, q) {
  return { kind, title, endpoint, q: q || {} };
}

async function fetchList(spec, page) {
  return tmdb(spec.endpoint, Object.assign({ page: page || 1, include_adult: false }, spec.q));
}

function rowRef(spec) {
  return makeRef({ k: spec.kind, e: spec.endpoint, q: spec.q });
}

async function listRows(specs) {
  const names = await genreNames();
  const pages = await pool(specs, 5, async (spec) => (await fetchList(spec, 1)).results);
  const rows = [];
  specs.forEach((spec, i) => {
    const items = itemsOf(pages[i], spec.kind, names).slice(0, ROW_ITEMS);
    if (items.length) rows.push({ id: "r" + hash(spec.endpoint + JSON.stringify(spec.q) + spec.kind), title: spec.title.slice(0, 100), items, ref: rowRef(spec) });
  });
  return rows;
}

/** The lists every kind has: what is trending, popular and best rated, and what is on now. */
function mainSpecs(kind) {
  const movie = kind === "movie";
  const word = movie ? "cinema" : "series";
  return [
    listSpec(kind, `${t(word)} · ${t("trending")}`, movie ? "/trending/movie/week" : "/trending/tv/week"),
    listSpec(kind, `${t(word)} · ${t("popular")}`, movie ? "/movie/popular" : "/tv/popular"),
    listSpec(kind, `${t(word)} · ${t("topRated")}`, movie ? "/movie/top_rated" : "/tv/top_rated"),
    listSpec(kind, `${t(word)} · ${t(movie ? "nowPlaying" : "onAir")}`, movie ? "/movie/now_playing" : "/tv/on_the_air"),
  ];
}

/** TMDB's own genre ids people look for most, per kind; the names come from TMDB in the person's language. */
const MOVIE_GENRES = [28, 35, 18, 27, 878, 16, 10749, 53, 12, 80, 14, 99];
const SERIES_GENRES = [10759, 35, 18, 80, 10765, 16, 9648, 10751, 99, 10762, 10764, 10766];

function genreSpecs(kind, names, limit) {
  const movie = kind === "movie";
  const table = movie ? names.movie : names.tv;
  const word = movie ? "cinema" : "series";
  return (movie ? MOVIE_GENRES : SERIES_GENRES)
    .filter((id) => table[id])
    .slice(0, limit)
    .map((id) => listSpec(kind, `${t(word)} · ${table[id]}`, movie ? "/discover/movie" : "/discover/tv", { with_genres: id, sort_by: "popularity.desc" }));
}

function rowsSetting() {
  const n = num(kino.config.get("homeRows"));
  return n > 0 && n <= 12 ? n : 4;
}


// Home has 20 s. Installing a scraper takes up to 45 s, so getting scrapers ready is a courtesy that never holds Home back:
// the rows are built first and the warm-up only gets the seconds that are left (a Home that waited for it showed nothing).
const HOME_BUDGET_MS = 14000;
const WARMUP_MAX_MS = 5000; // kino.sleep takes at most 5000 ms

export async function home() {
  const started = Date.now();
  const specs = mainSpecs("movie").concat(mainSpecs("series"));
  // Movies and series alternate, so a short Home shows both.
  const ordered = [];
  for (let i = 0; i < 4; i++) ordered.push(specs[i], specs[4 + i]);
  const rows = await listRows(ordered.slice(0, rowsSetting()));
  const left = Math.min(WARMUP_MAX_MS, HOME_BUDGET_MS - (Date.now() - started));
  if (left > 500 && typeof kino.nuvio === "object") {
    await Promise.race([prepare(1).catch((e) => { kino.log("warm-up failed: " + (e && e.code)); return null; }), kino.sleep(left)]);
  }
  return rows;
}

// ---- the section: two tabs (movies, series), each with the lists above and its genres

export async function section(arg) {
  const tabs = [
    { id: "cinema", label: t("cinema") },
    { id: "series", label: t("series") },
  ];
  const tab = tabs.find((x) => x.id === (arg && arg.tab)) || tabs[0];
  const kind = tab.id === "cinema" ? "movie" : "series";
  const names = await genreNames();
  return { tabs, tab: tab.id, rows: await listRows(mainSpecs(kind).concat(genreSpecs(kind, names, 6))) };
}

// ---- Categorías: a tile per genre, with a poster of its most popular title

const TTL_ART = 24 * 60 * 60 * 1000;
const ART_PER_CALL = 6; // posters asked per call: the rest fill in on later visits, so the TMDB budget is never spent here

async function genreArt(specs) {
  const key = "a1-" + tmdbLang();
  let cached = { at: Date.now(), v: {} };
  try {
    const e = JSON.parse(kino.storage.get(key) || "null");
    if (e && e.v && Date.now() - e.at < TTL_ART) cached = e;
  } catch { /* unreadable: start again */ }
  const missing = specs.filter((spec) => !cached.v[rowRef(spec)]).slice(0, ART_PER_CALL);
  if (missing.length) {
    const found = await pool(missing, 3, async (spec) => {
      const first = ((await fetchList(spec, 1)).results || []).find((r) => r.poster_path);
      return first ? image(first.poster_path, "w342") : undefined;
    });
    missing.forEach((spec, i) => { if (found[i]) cached.v[rowRef(spec)] = found[i]; });
    try { kino.storage.set(key, JSON.stringify(cached)); } catch { /* storage full: not cached */ }
  }
  return cached.v;
}

export async function categories() {
  const names = await genreNames();
  const specs = genreSpecs("movie", names, 8).concat(genreSpecs("series", names, 8));
  const art = await genreArt(specs);
  return specs.map((spec) => {
    const ref = rowRef(spec);
    const tile = { id: "g" + hash(ref), title: spec.title.slice(0, 40), ref };
    if (art[ref]) tile.art = art[ref];
    return tile;
  });
}

/** "Ver más": a page of the same TMDB list; the cursor is its page number. */
export async function browse(ref, cursor) {
  const r = parseRef(ref);
  if (!r.e || typeof r.e !== "string") throw kino.error("not_found", "bad ref", { userMessage: t("unknownRef") });
  const kind = r.k === "movie" ? "movie" : "series";
  const page = Math.max(1, num(cursor) || 1);
  const [names, data] = await Promise.all([genreNames(), fetchList({ endpoint: r.e, q: r.q || {} }, page)]);
  const items = itemsOf(data.results, kind, names);
  return page < Math.min(num(data.total_pages), 20) ? { items, next: String(page + 1) } : { items };
}

export async function search(query) {
  const q = String(query.q || "").trim();
  const wanted = query.type === "movie" ? "movie" : query.type === "series" ? "tv" : null;
  const names = await genreNames();
  // Kino looking for one title it already knows (by TMDB id): answer that title, whichever kind it is.
  if (query.tmdbId > 0) {
    const kinds = wanted === "tv" ? ["series"] : wanted === "movie" ? ["movie"] : ["movie", "series"];
    const found = await pool(kinds, 2, async (kind) => titleItem(await tmdb(kind === "movie" ? `/movie/${query.tmdbId}` : `/tv/${query.tmdbId}`), kind, names));
    const items = found.filter(Boolean);
    if (items.length) return items;
  }
  if (q.length < 2) return [];
  const data = await tmdb("/search/multi", { query: q, include_adult: false, page: 1 });
  const items = [];
  for (const r of data.results || []) {
    if (r.media_type !== "movie" && r.media_type !== "tv") continue;
    const item = titleItem(r, r.media_type === "movie" ? "movie" : "series", names);
    if (item) items.push(item);
  }
  // The type Kino leans towards goes first; the order inside each group is TMDB's.
  if (wanted) items.sort((a, b) => (a.kind === (wanted === "tv" ? "series" : "movie") ? 0 : 1) - (b.kind === (wanted === "tv" ? "series" : "movie") ? 0 : 1));
  return items.slice(0, 40);
}


// ---- 4. streams --------------------------------------------------------------------------------------------------

// The scrapers write the quality in their copies' labels ("1080p"): it only orders the copies.
const QUALITY_RANK = { "2160p": 4, "1080p": 3, "720p": 2, "480p": 1 };

function qualityOf(text) {
  const s = String(text || "").toLowerCase();
  if (/\b(2160p|4k)\b/.test(s)) return "2160p";
  for (const q of ["1080p", "720p", "480p"]) if (s.includes(q)) return q;
  return undefined;
}

function preferredRank() {
  const q = String(kino.config.get("quality") || "auto");
  return QUALITY_RANK[q] || QUALITY_RANK["1080p"];
}

/** One copy as the plugin offers it: the scraper's name in front of its own label, so the Servidor menu says where it comes from. */
function labelled(scraper, copy) {
  const own = String(copy.label || "").replace(VISUAL, "").replace(/\s+/g, " ").trim();
  return (own ? `${scraper.name} · ${own}` : scraper.name).slice(0, 48);
}

/** A page that only embeds a player (no media extension): the player tries real files first. */
function isEmbed(url) {
  const path = url.split("?")[0];
  return /\/(embed|e|v)\//i.test(path) && !/\.(m3u8|mp4|mkv|webm)$/i.test(path);
}

/** Every copy of every scraper that answered, flattened, with where it came from; duplicate addresses once. */
function copiesOf(results) {
  const seen = new Set();
  const out = [];
  for (const r of results) {
    if (!r.ok || !r.stream) continue;
    const s = r.stream;
    const all = [{ url: s.url, mime: s.mime, headers: s.headers, label: s.label }].concat(s.alternatives || []);
    all.forEach((copy, i) => {
      if (!copy || typeof copy.url !== "string" || seen.has(copy.url)) return;
      seen.add(copy.url);
      out.push({ scraper: r.scraper, copy, subtitles: i === 0 ? s.subtitles : undefined, rank: QUALITY_RANK[qualityOf(copy.label)] || 0, embed: isEmbed(copy.url) });
    });
  }
  return out;
}

/** Real files before embeds, then the closest to the preferred quality; ties keep the scrapers' order. */
function sorted(copies) {
  const want = preferredRank();
  const short = loadShort();
  const score = (c) => (c.rank ? Math.abs(c.rank - want) : 99);
  return copies
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (Number(a.c.embed) - Number(b.c.embed)) || (Number(!!short[a.c.scraper.id]) - Number(!!short[b.c.scraper.id])) || (score(a.c) - score(b.c)) || (a.i - b.i))
    .map((x) => x.c);
}

function streamFrom(copies) {
  const main = copies[0];
  const stream = { url: main.copy.url, label: labelled(main.scraper, main.copy) };
  if (main.copy.mime) stream.mime = main.copy.mime;
  if (main.copy.headers) stream.headers = main.copy.headers;
  const subs = [];
  const urls = new Set();
  for (const c of copies) for (const s of c.subtitles || []) if (s && s.url && !urls.has(s.url) && urls.add(s.url)) subs.push(s);
  if (subs.length) stream.subtitles = subs.slice(0, 30);
  const taken = new Set([stream.label]);
  const alternatives = [];
  for (const c of copies.slice(1, 9)) {
    const base = labelled(c.scraper, c.copy);
    let label = base;
    for (let n = 2; taken.has(label); n++) label = `${base.slice(0, 44)} ${n}`;
    taken.add(label);
    const alt = { url: c.copy.url, label };
    if (c.copy.mime) alt.mime = c.copy.mime;
    if (c.copy.headers) alt.headers = c.copy.headers;
    alternatives.push(alt);
  }
  if (alternatives.length) stream.alternatives = alternatives;
  // Which scraper each copy came from, so the player's events can be traced back to it.
  const owners = { [stream.label]: [main.scraper.id, hostOf(main.copy.url)] };
  copies.slice(1, 9).forEach((c, i) => { if (alternatives[i]) owners[alternatives[i].label] = [c.scraper.id, hostOf(c.copy.url)]; });
  try { kino.storage.set(LAST_KEY, JSON.stringify(owners)); } catch { /* storage full: not traced */ }
  return stream;
}

// The repository is the manifest's own ("nuvioRepos"): kino.nuvio refuses any other.
const REPO = "D3adlyRocket/All-in-One-Nuvio";

function repo() {
  return REPO;
}

function wanted() {
  const n = num(kino.config.get("scrapers"));
  return n > 0 && n <= 12 ? n : 6;
}

// ---- the scrapers: the plugin chooses them from what the repository offers, the app installs them as the importer does

const DEAD_KEY = "dead1";
const TTL_DEAD = 60 * 60 * 1000;

function hostOf(url) {
  const m = /^https?:\/\/([^/:?#]+)/i.exec(String(url || ""));
  return m ? m[1].toLowerCase() : "";
}

/** Hosts that did not answer at all (no DNS, no connection) lately, and when: their copies are not offered for an hour. */
function loadDead() {
  try {
    const h = JSON.parse(kino.storage.get(DEAD_KEY) || "{}");
    const out = {};
    for (const host of Object.keys(h)) if (Date.now() - h[host] < TTL_DEAD) out[host] = h[host];
    return out;
  } catch { return {}; }
}

function markDead(host) {
  if (!host) return;
  const h = loadDead();
  h[host] = Date.now();
  try { kino.storage.set(DEAD_KEY, JSON.stringify(h)); } catch { /* storage full: not remembered */ }
}

const SHORT_KEY = "short1";
const TTL_SHORT = 24 * 60 * 60 * 1000;
const LAST_KEY = "last1";

/** Scrapers that handed over a clip (a trailer, an ad) instead of the title, and when: their copies go last for a day. */
function loadShort() {
  try {
    const h = JSON.parse(kino.storage.get(SHORT_KEY) || "{}");
    const out = {};
    for (const id of Object.keys(h)) if (Date.now() - h[id] < TTL_SHORT) out[id] = h[id];
    return out;
  } catch { return {}; }
}

function markShort(id) {
  const h = loadShort();
  h[id] = Date.now();
  try { kino.storage.set(SHORT_KEY, JSON.stringify(h)); } catch { /* storage full: not remembered */ }
}

const HEALTH_KEY = "health1";
const TTL_HEALTH = 6 * 60 * 60 * 1000;
const MAX_WAVES = 2; // waves of scrapers asked for one title: the repository has many that no longer work
const RESOLVE_BUDGET_MS = 40000; // no new wave starts after this: the call has 75 s and the installs of a wave take their time
const SCRAPER_TIMEOUT_MS = 15000; // a scraper that hangs is cut here so it hides nothing

/** What happened to each scraper lately ({ id: [successes, failures, when] }): the ones that work are asked first. */
function loadHealth() {
  try {
    const h = JSON.parse(kino.storage.get(HEALTH_KEY) || "{}");
    const out = {};
    for (const id of Object.keys(h)) if (Date.now() - h[id][2] < TTL_HEALTH) out[id] = h[id];
    return out;
  } catch { return {}; }
}

function saveHealth(h) {
  try { kino.storage.set(HEALTH_KEY, JSON.stringify(h)); } catch { /* storage full: not remembered */ }
}

function note(h, results) {
  for (const r of results) {
    const id = r.scraper.id;
    const cur = h[id] || [0, 0, 0];
    h[id] = [cur[0] + (r.ok ? 1 : 0), cur[1] + (r.ok ? 0 : 1), Date.now()];
  }
}

/** The scrapers worth using, best first: ones that worked, installed ones, the person's language (or English), then the repository's order. */
function ranked(offered, health, anime) {
  const short = loadShort();
  const lang = String(kino.lang || "").toLowerCase().startsWith("es") ? "es" : "en";
  const score = (o) => {
    const langs = o.languages || [];
    const h = health[o.id];
    return (o.installed ? 0 : 3) + (langs.includes(lang) ? 0 : langs.includes("en") ? 1 : langs.length ? 2 : 1) + (h && h[0] > 0 ? -4 : 0) + (h && h[0] === 0 && h[1] >= 2 ? 8 : 0) + (anime && animeOnly(o) ? -6 : 0) + (short[o.id] ? 10 : 0);
  };
  return offered
    .filter((o) => o.compatible && (o.types.includes("movie") || o.types.includes("tv")) && (anime || !animeOnly(o)))
    .map((o, i) => ({ o, i }))
    .sort((a, b) => (score(a.o) - score(b.o)) || (a.i - b.i))
    .map((x) => x.o);
}

/** Why a scraper found nothing, in a few words the person can read (its own message is a developer's sentence). */
function why(r) {
  const m = String(r.message || "").toLowerCase();
  if (r.code === "timeout" || /timed out|timeout|tiempo agotado/.test(m)) return t("whyTimeout");
  if (/resolve host|\bdns\b|no address|no se encontr/.test(m)) return t("whyDown");
  if (/\b5\d\d\b|bad gateway|unavailable|network/.test(m)) return t("whyError");
  if (/sin resultados|no results|0 streams|ya no tiene/.test(m)) return t("whyNone");
  return t("whyOther");
}

/** A scraper's name as the person's message may carry it: Latin letters only, no emoji (Kino drops a message with other characters). */
function plainName(name) {
  return String(name || "").replace(/[^A-Za-z0-9À-ÿ .'-]/g, "").replace(/\s+/g, " ").trim().slice(0, 24) || "scraper";
}

/** "Ningún scraper encontró fuentes (N probados): A: motivo, B: motivo." in at most 160 characters, as many scrapers as fit. */
function failureMessage(items) {
  const head = t("noSourcesWhy", { n: items.length, list: "" });
  let list = "";
  for (const it of items) {
    const next = list ? `${list}, ${it}` : it;
    if ((head + next).length > 158) break;
    list = next;
  }
  return t("noSourcesWhy", { n: items.length, list }).slice(0, 160);
}

// Scrapers made for anime: a title that is not animation is not worth their time, an animation title asks them first.
function animeOnly(o) {
  return /anime|manga|\bani[a-z]/i.test(`${o.name} ${o.description || ""}`);
}

async function isAnimation(r) {
  try {
    const meta = await metaOf(r.k, r.t);
    return (meta.genres || []).some((g) => /anim/i.test(String(g)));
  } catch { return false; }
}

let OFFERED = null;

async function offeredNow() {
  if (OFFERED && Date.now() - OFFERED.at < 2 * 60 * 1000 && OFFERED.repo === repo()) return OFFERED.list;
  const list = await kino.nuvio.available({ repo: repo() });
  OFFERED = { at: Date.now(), repo: repo(), list };
  return list;
}

/** Makes the top scrapers ready (the app installs the missing ones with no screen), at most `room` new ones; how many are ready. */
async function prepare(room) {
  const offered = await offeredNow();
  const top = ranked(offered, loadHealth(), false).slice(0, wanted());
  const missing = top.filter((o) => !o.installed).slice(0, room).map((o) => o.id);
  if (missing.length) {
    const r = await kino.nuvio.use({ repo: repo(), scrapers: missing });
    for (const f of r.failed) kino.log("scraper " + f.id + " not prepared: " + f.code);
    OFFERED = null;
    return top.filter((o) => o.installed).length + r.ready.length;
  }
  return top.filter((o) => o.installed).length;
}

// ---- clips before they play: the size of a file, or the length of an HLS list, is asked of its server first

const PROBE_MS = 4000;
const PROBE_COPIES = 6; // the best copies are checked; the rest are left as they are
const CLIP_BYTES_MOVIE = 25 * 1024 * 1024;
const CLIP_BYTES_EPISODE = 10 * 1024 * 1024;

function probing() {
  return kino.config.get("probe") !== false;
}

/** The file's size in bytes without downloading it (HEAD, else a range of one byte), "dead" when its server is gone, "weak" when it answers with a server error, undefined when it will not say. */
async function sizeOf(copy) {
  const headers = Object.assign({}, copy.headers || {});
  let unreachable = false;
  let failing = false;
  try {
    const h = await kino.fetch(copy.url, { method: "HEAD", headers, timeoutMs: PROBE_MS });
    const len = num(h.headers["content-length"]);
    if (h.ok && len > 0) return len;
    if (h.status === 404 || h.status === 410) return "dead";
    failing = h.status >= 500;
  } catch (e) { unreachable = !!(e && e.code === "network"); /* try a range of one byte */ }
  try {
    const g = await kino.fetch(copy.url, { headers: Object.assign({ Range: "bytes=0-0" }, headers), timeoutMs: PROBE_MS });
    const m = /\/(\d+)\s*$/.exec(String(g.headers["content-range"] || ""));
    if (m) return num(m[1]);
    if (g.status === 404 || g.status === 410) return "dead";
    if (failing && g.status >= 500) return "weak";
  } catch (e) { if (unreachable && e && e.code === "network") return "dead"; }
  return undefined;
}

/** An HLS list's total seconds (a master list: its first rendition's), or undefined for a live one or one that cannot be read. */
async function hlsSeconds(copy) {
  const headers = Object.assign({}, copy.headers || {});
  let url = copy.url;
  for (let hop = 0; hop < 2; hop++) {
    const r = await kino.fetch(url, { headers, timeoutMs: PROBE_MS });
    if (!r.ok) return undefined;
    const text = r.text();
    if (/#EXT-X-STREAM-INF/.test(text)) {
      const next = text.split("\n").map((l) => l.trim()).find((l) => l && l[0] !== "#");
      if (!next) return undefined;
      url = new URL(next, url).toString();
      continue;
    }
    if (!/#EXT-X-ENDLIST/.test(text)) return undefined;
    let total = 0;
    const re = /#EXTINF:([\d.]+)/g;
    let m;
    while ((m = re.exec(text))) total += parseFloat(m[1]);
    return total > 0 ? total : undefined;
  }
  return undefined;
}

/** "clip" when a copy is not the title, "dead" when its server does not answer, "weak" when it fails now (a server error, maybe not later), false otherwise. Only https on the default port can be asked; what is unknown stays. */
async function verdictOf(copy, isMovie, minMs) {
  if (!/^https:\/\/[^/:?#]+(\/|\?|$)/i.test(copy.url)) return false;
  if (/\.m3u8/i.test(copy.url)) {
    try {
      const seconds = await hlsSeconds(copy);
      return seconds !== undefined && seconds * 1000 < minMs ? "clip" : false;
    } catch (e) { return e && e.code === "network" ? "dead" : false; }
  }
  const bytes = await sizeOf(copy);
  if (bytes === "dead" || bytes === "weak") return bytes;
  return bytes !== undefined && bytes < (isMovie ? CLIP_BYTES_MOVIE : CLIP_BYTES_EPISODE) ? "clip" : false;
}

/**
 * The copies that are worth opening: the ones on a host known to be gone are left out at once, the best few of the rest are asked in
 * parallel (a clip or a dead server goes), a scraper whose every checked copy is a clip is remembered as a clip-maker, a host that does
 * not answer as dead, and if all would go, nothing does (a copy that may fail is better than none).
 */
async function dropClips(copies, r) {
  const dead = loadDead();
  const alive = copies.filter((c) => !dead[hostOf(c.copy.url)]);
  const pool0 = alive.length ? alive : copies;
  if (!probing()) return pool0;
  const head = pool0.slice(0, PROBE_COPIES);
  const isMovie = r.k === "movie";
  const minMs = await expectedMsFor(isMovie, r.t);
  const verdicts = await pool(head, 5, async (c) => {
    try { return await verdictOf(c.copy, isMovie, minMs); } catch { return false; }
  });
  const kept = [];
  const weak = []; // failing right now: tried after the others, not forgotten
  const seen = new Map();
  head.forEach((c, i) => {
    const sc = seen.get(c.scraper.id) || { all: 0, clips: 0 };
    sc.all++;
    if (verdicts[i] === "clip") sc.clips++;
    seen.set(c.scraper.id, sc);
    if (verdicts[i] === "dead") markDead(hostOf(c.copy.url));
    if (verdicts[i] === "weak") weak.push(c);
    else if (!verdicts[i]) kept.push(c);
  });
  for (const [id, sc] of seen) if (sc.clips === sc.all) markShort(id);
  const dropped = head.length - kept.length - weak.length;
  if (dropped) kino.log("copies dropped before playing: " + dropped + " of " + head.length);
  return kept.length ? kept.concat(pool0.slice(PROBE_COPIES), weak) : pool0;
}

/** What the scrapers take is the TMDB id, so a ref needs no IMDb id: a series ref only adds its season and episode. */
export async function resolve(ref) {
  const r = parseRef(ref);
  if (!r.t || (r.k !== "movie" && r.k !== "series")) throw kino.error("not_found", "bad ref", { userMessage: t("unknownRef") });
  if (typeof kino.nuvio !== "object") throw kino.error("unavailable", "no kino.nuvio", { userMessage: t("noScrapers") });
  const where = repo();
  const started = Date.now();
  const health = loadHealth();
  const tried = new Set();
  const failures = [];
  let order;
  try {
    order = ranked(await offeredNow(), health, await isAnimation(r));
  } catch (e) {
    kino.log("kino.nuvio.available failed: " + (e && e.code));
    throw kino.error("unavailable", "nuvio " + (e && e.code), { userMessage: (e && e.userMessage) || t("noScrapers") });
  }
  const installed = new Set(order.filter((o) => o.installed).map((o) => o.id));
  for (let wave = 0; wave < MAX_WAVES && Date.now() - started < RESOLVE_BUDGET_MS; wave++) {
    const pick = order.filter((o) => !tried.has(o.id)).slice(0, wanted()).map((o) => o.id);
    if (!pick.length) break;
    pick.forEach((id) => tried.add(id));
    const missing = pick.filter((id) => !installed.has(id));
    if (missing.length) {
      try {
        const u = await kino.nuvio.use({ repo: where, scrapers: missing });
        u.ready.forEach((id) => installed.add(id));
        for (const f of u.failed) kino.log("scraper " + f.id + " not prepared: " + f.code);
      } catch (e) {
        kino.log("kino.nuvio.use failed: " + (e && e.code));
      }
    }
    const ready = pick.filter((id) => installed.has(id));
    if (!ready.length) continue;
    const query = { repo: where, type: r.k, tmdbId: r.t, scrapers: ready, timeoutMs: SCRAPER_TIMEOUT_MS };
    if (r.k === "series") { query.season = num(r.s) || 1; query.episode = num(r.e) || 1; }
    let answer;
    try {
      answer = await kino.nuvio.streams(query);
    } catch (e) {
      kino.log("kino.nuvio.streams failed: " + (e && e.code));
      throw kino.error("unavailable", "nuvio " + (e && e.code), { userMessage: (e && e.userMessage) || t("noSources", { asked: tried.size }) });
    }
    const results = answer.results || [];
    note(health, results);
    const copies = sorted(copiesOf(results));
    if (copies.length) {
      saveHealth(health);
      return streamFrom(await dropClips(copies, r));
    }
    for (const x of results) failures.push(`${plainName(x.scraper.name)}: ${why(x)}`);
  }
  saveHealth(health);
  if (!tried.size || !failures.length) throw kino.error("unavailable", "no scrapers", { userMessage: t("noScrapers") });
  kino.log("kino.nuvio: " + failures.join("; "));
  throw kino.error("unavailable", "no sources", { userMessage: failureMessage(failures) });
}

// ---- the player tells how long the copy is: a clip is remembered, the scraper that made it goes last

/** The least a title is worth: half its TMDB runtime for a movie (at least 30 minutes, 40 when unknown), 8 minutes for an episode. */
async function expectedMsFor(isMovie, tmdbId) {
  if (!isMovie) return 8 * 60 * 1000;
  let minutes = 40;
  try {
    const answer = await metaOf("movie", tmdbId);
    if (answer && answer.runtimeMinutes) minutes = Math.max(30, answer.runtimeMinutes * 0.5);
  } catch { /* no runtime known: a movie under 40 minutes is still not one */ }
  return minutes * 60 * 1000;
}

export async function playerEvent(event, context) {
  if (!event || !context || context.kind === "live") return null;
  let owners = {};
  try { owners = JSON.parse(kino.storage.get(LAST_KEY) || "{}"); } catch { /* nothing traced */ }
  const owner = owners[context.playing && context.playing.label];
  if (!owner) return null;
  // A copy whose server cannot be reached: not offered again for an hour.
  if (event.type === "failed" && /network|connection|resolve|host/i.test(String(event.kind || ""))) {
    markDead(owner[1]);
    return null;
  }
  if (event.type !== "started" || !context.durationMs) return null;
  if (context.durationMs >= (await expectedMsFor(context.kind === "movie", context.ids && context.ids.tmdb))) return null;
  markShort(owner[0]);
  return { message: t("shortClip", { n: Math.round(context.durationMs / 1000) }) };
}

// ---- 5. settings -------------------------------------------------------------------------------------------------

export async function settingsStatus() {
  try {
    const list = await kino.nuvio.scrapers({ repo: repo() });
    return { scraperStatus: t("ok", { n: list.length }) };
  } catch (e) {
    return { scraperStatus: t("offline", { detail: (e && (e.userMessage || e.code)) || "error" }) };
  }
}

/** Prepares the scrapers now (a few per press), so the first play does not wait for them. */
export async function action(key) {
  if (key !== "check") return null;
  const n = await prepare(3);
  return { message: n ? t("ok", { n }) + " " + t("preparing") : t("noScrapers") };
}
