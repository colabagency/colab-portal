// ─────────────────────────────────────────────────────────────
// CO/LAB — librería compartida para las funciones serverless
// Sin dependencias externas: usa crypto y fetch nativos de Node 18+.
// ─────────────────────────────────────────────────────────────
import crypto from "node:crypto";

const SHEET_ID = process.env.SHEET_ID;
const SA_EMAIL = process.env.GOOGLE_SA_EMAIL;
const SA_KEY   = (process.env.GOOGLE_SA_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const SESSION_SECRET = process.env.SESSION_SECRET;

export function assertEnv() {
  const missing = ["SHEET_ID","GOOGLE_SA_EMAIL","GOOGLE_SA_PRIVATE_KEY","SESSION_SECRET"]
    .filter(k => !process.env[k]);
  if (missing.length) throw new Error("Faltan variables de entorno: " + missing.join(", "));
}

/* ── Token de acceso de Google (cuenta de servicio) ───────────
   Se cachea en memoria del contenedor; en invocaciones "calientes"
   se reutiliza y no se vuelve a pedir. */
let _token = null, _tokenExp = 0;

function b64url(buf) {
  return Buffer.from(buf).toString("base64")
    .replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_token && now < _tokenExp - 60) return _token;

  const header = b64url(JSON.stringify({ alg:"RS256", typ:"JWT" }));
  const claim  = b64url(JSON.stringify({
    iss: SA_EMAIL,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  }));
  const unsigned = `${header}.${claim}`;
  const signature = b64url(crypto.sign("RSA-SHA256", Buffer.from(unsigned), SA_KEY));
  const jwt = `${unsigned}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error("Google OAuth: " + (data.error_description || data.error || res.status));

  _token = data.access_token;
  _tokenExp = now + (data.expires_in || 3600);
  return _token;
}

/* ── Sheets: leer y escribir ─────────────────────────────── */
const API = "https://sheets.googleapis.com/v4/spreadsheets";

export async function readSheet(tabName) {
  const token = await getAccessToken();
  const range = `'${String(tabName).replace(/'/g, "''")}'`;
  const url = `${API}/${SHEET_ID}/values/${encodeURIComponent(range)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (!res.ok) throw new Error(`Sheets ${res.status}: ${data?.error?.message || "error"}`);
  return data.values || [];
}

export async function updateCell(tabName, a1, value) {
  const token = await getAccessToken();
  const range = `'${String(tabName).replace(/'/g, "''")}'!${a1}`;
  const url = `${API}/${SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [[value]] })
  });
  if (!res.ok) {
    const d = await res.json().catch(()=>({}));
    throw new Error(`Sheets update ${res.status}: ${d?.error?.message || "error"}`);
  }
}

export async function appendRow(tabName, values) {
  const token = await getAccessToken();
  const range = `'${String(tabName).replace(/'/g, "''")}'!A:A`;
  const url = `${API}/${SHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [values] })
  });
  if (!res.ok) {
    const d = await res.json().catch(()=>({}));
    throw new Error(`Sheets append ${res.status}: ${d?.error?.message || "error"}`);
  }
}

/* ── Mapeo de columnas por nombre, tolerante a renombres ──────
   Primero busca el nombre exacto; si no existe, acepta cualquier
   encabezado que EMPIECE con ese texto. Así "Status" sigue
   funcionando aunque en el Sheet se llame "Status de la Campaña". */
export function normHeader(s) {
  return String(s == null ? "" : s)
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildHeaderMap(headerRow) {
  const map = {};
  (headerRow || []).forEach((h, i) => {
    const k = normHeader(h);
    if (k && !(k in map)) map[k] = i;
  });
  return map;
}

export function findCol(map, aliases, fallbackIdx) {
  for (const a of aliases) if (map[a] !== undefined) return map[a];
  const keys = Object.keys(map).sort((a, b) => a.length - b.length);
  for (const a of aliases) {
    const hit = keys.find(k => k.startsWith(a));
    if (hit !== undefined) return map[hit];
  }
  return fallbackIdx;
}

/* ── Contraseñas: scrypt con salt por usuario ─────────────────
   Formato guardado: scrypt$<salt hex>$<hash hex>
   Si el valor guardado no tiene ese formato, se asume texto plano
   heredado: se valida y se re-guarda hasheado (migración suave). */
export function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, 32);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(plain, stored) {
  const s = String(stored || "");
  if (!s) return { ok: false, legacy: false };
  if (!s.startsWith("scrypt$")) {
    // Texto plano heredado
    const a = Buffer.from(String(plain));
    const b = Buffer.from(s);
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    return { ok, legacy: true };
  }
  const [, saltHex, hashHex] = s.split("$");
  try {
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const actual = crypto.scryptSync(String(plain), salt, expected.length);
    return { ok: crypto.timingSafeEqual(actual, expected), legacy: false };
  } catch {
    return { ok: false, legacy: false };
  }
}

/* ── Sesiones firmadas (HMAC), sin base de datos ───────────── */
export function createSession(payload, hours = 12) {
  const body = { ...payload, exp: Date.now() + hours * 3600 * 1000 };
  const data = b64url(JSON.stringify(body));
  const sig = b64url(crypto.createHmac("sha256", SESSION_SECRET).update(data).digest());
  return `${data}.${sig}`;
}

export function readSession(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [data, sig] = token.split(".");
  const expected = b64url(crypto.createHmac("sha256", SESSION_SECRET).update(data).digest());
  const a = Buffer.from(sig || ""), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const body = JSON.parse(Buffer.from(data.replace(/-/g,"+").replace(/_/g,"/"), "base64").toString());
    if (!body.exp || Date.now() > body.exp) return null;
    return body;
  } catch { return null; }
}

export function sessionFromRequest(req) {
  const h = req.headers.authorization || "";
  return readSession(h.startsWith("Bearer ") ? h.slice(7) : null);
}

/* ── Utilidades ──────────────────────────────────────────── */
export function readBody(req) {
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  return new Promise(resolve => {
    let raw = "";
    req.on("data", c => raw += c);
    req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { resolve({}); } });
  });
}

export function parseNumber(str) {
  if (!str) return 0;
  return parseFloat(String(str).replace(/[$,\s]/g, "")) || 0;
}

export const TAB_VENTAS   = process.env.TAB_VENTAS   || "Ventas";
export const TAB_TALENTOS = process.env.TAB_TALENTOS || "Lista de Talento Activos";
export const TAB_USUARIOS = process.env.TAB_USUARIOS || "Usuarios";
