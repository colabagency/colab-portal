// ─────────────────────────────────────────────────────────────
// /api/data — entrega talentos y campañas YA FILTRADOS por rol.
// Un talento nunca recibe las filas de otro: el filtro ocurre aquí,
// no en el navegador.
// ─────────────────────────────────────────────────────────────
import {
  assertEnv, readSheet, buildHeaderMap, findCol, parseNumber,
  sessionFromRequest, TAB_VENTAS, TAB_TALENTOS
} from "./_lib.js";

const norm = s => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

function extractHandle(raw) {
  if (!raw) return "";
  const s = String(raw).trim();
  const at = s.match(/@([A-Za-z0-9._]+)/);
  if (at) return at[1];
  const url = s.match(/(?:instagram\.com|tiktok\.com)\/@?([A-Za-z0-9._]+)/i);
  if (url) return url[1];
  return s.split("(")[0].trim();
}

function formatDateLabel(dateStr) {
  const months = { enero:"Ene", febrero:"Feb", marzo:"Mar", abril:"Abr",
    mayo:"May", junio:"Jun", julio:"Jul", agosto:"Ago",
    septiembre:"Sep", octubre:"Oct", noviembre:"Nov", diciembre:"Dic" };
  const parts = String(dateStr).trim().toLowerCase().split(" ");
  if (parts.length >= 3) {
    const m = months[parts[1]] || parts[1];
    return `${parts[0]} ${m.charAt(0).toUpperCase() + m.slice(1)} ${parts[2]}`;
  }
  return dateStr;
}

async function loadTalentos() {
  const rows = await readSheet(TAB_TALENTOS);
  const header = rows.length ? rows.shift() : [];
  const H = buildHeaderMap(header);

  // Igual que en Ventas: se busca por NOMBRE de encabezado, y si no aparece
  // se cae a la posición histórica. Así un cambio de columnas no rompe nada.
  const T = {
    status:     findCol(H, ["status", "estatus"],                       0),
    clave:      findCol(H, ["clave talento", "clave"],                  1),
    nombre:     findCol(H, ["talento", "nombre"],                       2),
    categoria:  findCol(H, ["categoria", "categorias"],                 6),
    manager:    findCol(H, ["manager"],                                19),
    fee:        findCol(H, ["fee agencia", "fee", "% fee", "fee %"],   21),
    instagram:  findCol(H, ["instagram", "ig"],                        14),
    tiktok:     findCol(H, ["tiktok", "tik tok", "tt"],                15),
    contrato:   findCol(H, ["contrato", "tipo de contrato"],           20),
    antiguedad: findCol(H, ["antiguedad", "antiguedad meses"],         23),
  };

  const TALENTS = {};
  for (const row of rows) {
    const clave  = (row[T.clave]  || "").trim();
    const nombre = (row[T.nombre] || "").trim();
    if (!clave || !nombre) continue;
    const key = clave.toLowerCase().replace(/[^a-z0-9]/g, "_");
    const primer = nombre.split(" ")[0];
    TALENTS[key] = {
      clave, nombre,
      apodo: primer.charAt(0).toUpperCase() + primer.slice(1).toLowerCase(),
      manager: (row[T.manager] || "Mariana Llaneza").trim(),
      fee_pct: parseFloat(String(row[T.fee] || "0").replace("%", "")) || 25,
      categoria: (row[T.categoria] || "—").trim(),
      instagram: extractHandle(row[T.instagram]),
      tiktok: extractHandle(row[T.tiktok]),
      contrato: (row[T.contrato] || "").trim() || "—",
      antiguedad: (row[T.antiguedad] || "").trim() ? (row[T.antiguedad] || "").trim() + " meses" : "—",
      status: (row[T.status] || "").trim()
    };
  }
  // Se devuelven también los encabezados reales, para poder diagnosticar
  // desde la consola si algún día algo no cuadra.
  return { TALENTS, header, cols: T };
}

async function loadCampanas(TALENTS) {
  const rows = await readSheet(TAB_VENTAS);
  const header = rows.length ? rows.shift() : [];
  const H = buildHeaderMap(header);

  const C = {
    id:      findCol(H, ["no de campana"],      3),
    nombre:  findCol(H, ["talento"],            4),
    clave:   findCol(H, ["clave talento"],      5),
    manager: findCol(H, ["manager"],            7),
    campana: findCol(H, ["campana"],            8),
    agencia: findCol(H, ["agencia"],           10),
    marca:   findCol(H, ["marca"],             11),
    fIni:    findCol(H, ["fecha inicio"],      12),
    fFin:    findCol(H, ["fecha final"],       13),
    // Acepta "Status" y también "Status de la Campaña"
    status:  findCol(H, ["status", "estatus"], 15),
    cfdi:    findCol(H, ["cfdis emitidos"],    16),
    sub:     findCol(H, ["subtotal campana"],  17),
    fee:     findCol(H, ["fee agencia"],       22),
    sub_t:   findCol(H, ["subtotal talento"],  23),
    iva:     findCol(H, ["iva"],               24),
    iva_ret: findCol(H, ["iva retenido"],      25),
    isr:     findCol(H, ["isr retenido"],      26),
    total_t: findCol(H, ["total talento"],     27),
    cob_t:   findCol(H, ["cobrado talento"],   28),
    por_t:   H["por cobrar talento"] !== undefined ? H["por cobrar talento"] : null,
  };

  // Saltar filas vacías después del encabezado
  while (rows.length && !String(rows[0][C.id] || "").trim()) rows.shift();

  const out = [];
  for (const row of rows) {
    const id      = String(row[C.id]      || "").trim();
    const campana = String(row[C.campana] || "").trim();
    const sub     = parseNumber(row[C.sub]);
    if (!id || !campana || sub === 0) continue;

    const nombre  = String(row[C.nombre] || "").trim();
    const total_t = parseNumber(row[C.total_t]);
    const cob_t   = parseNumber(row[C.cob_t]);

    let clave = String(row[C.clave] || "").trim();
    if (!clave) {
      if (!nombre || nombre.toUpperCase() === "N/A") clave = "N/A";
      else {
        const m = Object.values(TALENTS).find(t => norm(t.nombre) === norm(nombre));
        clave = m ? m.clave : "N/A";
      }
    }

    out.push({
      id, talento_clave: clave, nombre,
      manager: String(row[C.manager] || "").trim(),
      campana,
      agencia: String(row[C.agencia] || "").trim(),
      marca:   String(row[C.marca]   || "").trim(),
      fecha_inicio: formatDateLabel(String(row[C.fIni] || "").trim()),
      fecha_fin:    formatDateLabel(String(row[C.fFin] || "").trim()),
      status: String(row[C.status] || "").trim(),
      cfdi:   String(row[C.cfdi]   || "").trim(),
      subtotal: sub,
      fee:     parseNumber(row[C.fee]),
      sub_t:   parseNumber(row[C.sub_t]),
      iva:     parseNumber(row[C.iva]),
      iva_ret: parseNumber(row[C.iva_ret]),
      isr:     parseNumber(row[C.isr]),
      total_t,
      cobrado_t: cob_t,
      por_cobrar_t: C.por_t !== null ? parseNumber(row[C.por_t]) : Math.max(0, total_t - cob_t)
    });
  }
  return out;
}

export default async function handler(req, res) {
  try {
    assertEnv();
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }

  const ses = sessionFromRequest(req);
  if (!ses) return res.status(401).json({ ok: false, error: "Sesión inválida o expirada" });

  try {
    const { TALENTS, header: tHeader } = await loadTalentos();
    const CAMPAIGNS = await loadCampanas(TALENTS);

    // Diagnóstico: aparece en la consola del navegador y dice de inmediato
    // si el problema es la pestaña de talentos, la de ventas, o el usuario.
    const diag = {
      talentosLeidos: Object.keys(TALENTS).length,
      campanasLeidas: CAMPAIGNS.length,
      clavesDisponibles: Object.values(TALENTS).map(t => t.clave),
      encabezadosTalentos: tHeader,
      tuClave: ses.clave || "(vacía)",
      tuRol: ses.role
    };

    let talents = TALENTS;
    let camps   = CAMPAIGNS;
    let me = null;

    if (ses.role === "talento") {
      // Solo sus propias campañas y solo su propia ficha.
      camps = CAMPAIGNS.filter(c => c.talento_clave === ses.clave);
      const mine = Object.values(TALENTS).find(t => t.clave === ses.clave);
      talents = {};
      if (mine) {
        const key = ses.clave.toLowerCase().replace(/[^a-z0-9]/g, "_");
        talents[key] = { ...mine, email: ses.email };
        me = { ...mine, email: ses.email };
      }
    } else if (ses.role === "manager") {
      const mgr = norm(ses.managerOf || "");
      talents = Object.fromEntries(
        Object.entries(TALENTS).filter(([, t]) => norm(t.manager) === mgr)
      );
      const claves = new Set(Object.values(talents).map(t => t.clave));
      camps = CAMPAIGNS.filter(c => claves.has(c.talento_clave));
      me = { clave: "ADMIN", nombre: ses.email, apodo: (ses.managerOf || "Manager").split(" ")[0], email: ses.email, manager: "CO/LAB Agency", fee_pct: 0 };
    } else {
      me = { clave: "ADMIN", nombre: ses.email, apodo: "Admin", email: ses.email, manager: "CO/LAB Agency", fee_pct: 0 };
    }

    return res.status(200).json({
      ok: true,
      role: ses.role,
      managerOf: ses.managerOf || null,
      me,
      talents,
      campaigns: camps,
      diag
    });
  } catch (e) {
    console.error("data:", e);
    return res.status(500).json({ ok: false, error: "No se pudieron cargar los datos" });
  }
}
