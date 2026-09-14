// ─────────────────────────────────────────────────────────────
// /api/auth — login, registro y restablecer contraseña.
// Todo contra la pestaña "Usuarios" del Sheet privado.
// Columnas esperadas: Correo | Contraseña | Clave Talento | Fecha Creacion
// Opcionales (si existen, se usan): Rol | Manager | Nombre
// ─────────────────────────────────────────────────────────────
import {
  assertEnv, readSheet, updateCell, appendRow,
  buildHeaderMap, findCol, hashPassword, verifyPassword,
  createSession, readBody, TAB_USUARIOS, TAB_TALENTOS
} from "./_lib.js";

function colLetter(i) {
  let s = "";
  i = i + 1;
  while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

async function loadUsuarios() {
  const rows = await readSheet(TAB_USUARIOS);
  const header = rows.length ? rows.shift() : [];
  const H = buildHeaderMap(header);
  const idx = {
    correo:  findCol(H, ["correo", "email"], 0),
    pass:    findCol(H, ["contrasena", "password"], 1),
    clave:   findCol(H, ["clave talento", "clave"], 2),
    fecha:   findCol(H, ["fecha creacion", "fecha"], 3),
    rol:     H["rol"],       // opcional
    manager: H["manager"],   // opcional
    nombre:  H["nombre"],    // opcional
  };
  // La fila 1 es el encabezado, así que la fila del Sheet = índice + 2
  const users = rows.map((r, i) => ({
    row: i + 2,
    correo: String(r[idx.correo] || "").trim().toLowerCase(),
    pass:   String(r[idx.pass]   || ""),
    clave:  String(r[idx.clave]  || "").trim(),
    rol:     idx.rol     !== undefined ? String(r[idx.rol]     || "").trim() : "",
    manager: idx.manager !== undefined ? String(r[idx.manager] || "").trim() : "",
    nombre:  idx.nombre  !== undefined ? String(r[idx.nombre]  || "").trim() : "",
  })).filter(u => u.correo);
  return { users, idx };
}

// Determina el rol a partir de la columna Rol, o lo infiere de Clave Talento.
function resolveRole(u) {
  const rol = (u.rol || "").toLowerCase();
  if (rol.startsWith("admin"))   return "admin";
  if (rol.startsWith("manager")) return "manager";
  if ((u.clave || "").toUpperCase() === "ADMIN") return "admin";
  return "talento";
}

export default async function handler(req, res) {
  try {
    assertEnv();
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Método no permitido" });

  const body = await readBody(req);
  const action = String(body.action || "login");
  const email  = String(body.email || "").trim().toLowerCase();
  const pass   = String(body.password || "");

  if (!email) return res.status(400).json({ ok: false, error: "Falta el correo" });

  try {
    const { users, idx } = await loadUsuarios();
    const user = users.find(u => u.correo === email);

    /* ── LOGIN ── */
    if (action === "login") {
      // Mensaje idéntico exista o no el correo: no revelamos qué correos están dados de alta.
      const generic = { ok: false, error: "Correo o contraseña incorrectos" };
      if (!user) return res.status(401).json(generic);

      const check = verifyPassword(pass, user.pass);
      if (!check.ok) return res.status(401).json(generic);

      // Migración suave: si estaba en texto plano, lo re-guardamos hasheado.
      if (check.legacy) {
        try { await updateCell(TAB_USUARIOS, `${colLetter(idx.pass)}${user.row}`, hashPassword(pass)); }
        catch (e) { console.error("No se pudo migrar el hash:", e.message); }
      }

      const role = resolveRole(user);
      const token = createSession({
        clave: user.clave || "",
        email: user.correo,
        role,
        managerOf: role === "manager" ? (user.manager || user.nombre || "") : null
      });
      return res.status(200).json({ ok: true, token });
    }

    /* ── REGISTRO ── */
    if (action === "register") {
      if (pass.length < 6) return res.status(400).json({ ok: false, error: "La contraseña debe tener al menos 6 caracteres" });

      if (user) {
        // Ya existe: solo permitimos fijar contraseña si aún no tiene una.
        if (user.pass) return res.status(409).json({ ok: false, error: "Esta cuenta ya existe. Inicia sesión o usa '¿Olvidaste tu contraseña?'" });
        await updateCell(TAB_USUARIOS, `${colLetter(idx.pass)}${user.row}`, hashPassword(pass));
        return res.status(200).json({ ok: true });
      }

      // No existe en Usuarios: solo se puede dar de alta si el correo
      // está en la lista de talentos. Nadie se registra por su cuenta.
      const tRows = await readSheet(TAB_TALENTOS);
      const tHeader = tRows.length ? tRows.shift() : [];
      const TH = buildHeaderMap(tHeader);
      const cEmail = findCol(TH, ["correo", "email", "mail"], 9);
      const cClave = findCol(TH, ["clave talento", "clave"], 1);
      const match = tRows.find(r => String(r[cEmail] || "").trim().toLowerCase() === email);
      if (!match) return res.status(403).json({ ok: false, error: "Este correo no está registrado en CO/LAB. Contacta a tu manager." });

      const fila = [];
      fila[idx.correo] = email;
      fila[idx.pass]   = hashPassword(pass);
      fila[idx.clave]  = String(match[cClave] || "").trim();
      fila[idx.fecha]  = new Date().toISOString().slice(0, 10);
      for (let i = 0; i < fila.length; i++) if (fila[i] === undefined) fila[i] = "";
      await appendRow(TAB_USUARIOS, fila);
      return res.status(200).json({ ok: true });
    }

    /* ── RESTABLECER ── */
    if (action === "reset") {
      // Respuesta idéntica exista o no la cuenta, para no filtrar correos.
      if (!user) return res.status(200).json({ ok: true });
      const temporal = "colab" + Math.floor(1000 + Math.random() * 9000);
      await updateCell(TAB_USUARIOS, `${colLetter(idx.pass)}${user.row}`, hashPassword(temporal));
      // OJO: hoy la temporal se devuelve en la respuesta. Cuando conectes envío
      // de correo, quita "temporal" de aquí y mándala por mail.
      return res.status(200).json({ ok: true, temporal });
    }

    return res.status(400).json({ ok: false, error: "Acción no reconocida" });
  } catch (e) {
    console.error("auth:", e);
    return res.status(500).json({ ok: false, error: "Error del servidor" });
  }
}
