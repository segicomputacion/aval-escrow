/* ============================================
   AVAL ESCROW v2 - APP LOGIC (con autenticación)
   ============================================ */

const APP = { usuario: null };

// -------------------------------------------------------------------
// HELPERS
// -------------------------------------------------------------------
function $(id) { return document.getElementById(id); }

function esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function mostrarToast(msg, tipo) {
    const container = $('toastContainer');
    const toast = document.createElement('div');
    toast.className = 'toast ' + (tipo || 'info');
    toast.textContent = (iconos[tipo] || 'ℹ️') + ' ' + msg;
    container.appendChild(toast);
    setTimeout(() => { toast.remove(); }, 4000);
}
const iconos = { success: '✅', error: '❌', info: 'ℹ️' };

// --- MODAL (login, confirmaciones, retiro) ---
let modalCallback = null;

function abrirModal(titulo, desc, btnText, callback) {
    $('modalTitle').textContent = titulo;
    $('modalDesc').textContent = desc;
    $('modalNombre').value = '';
    $('modalEmail').value = '';
    $('modalNombre').type = 'text';
    $('modalEmail').type = 'email';
    $('modalNombre').style.display = '';
    $('modalEmail').style.display = '';
    $('modalNombre').style.textAlign = '';
    $('modalNombre').style.fontSize = '';
    $('modalNombre').style.letterSpacing = '';
    $('modalNombre').placeholder = 'Tu nombre completo';
    $('modalEmail').placeholder = 'Tu email';
    document.querySelector('#modalRegistro .btn-primary').textContent = btnText;
    modalCallback = callback;
    $('modalRegistro').classList.add('open');
    setTimeout(() => $('modalNombre').focus(), 100);
}

function setModalCodeStep(email) {
    $('modalTitle').textContent = '🔐 Ingresá el código';
    $('modalDesc').textContent = `Te enviaremos un código a ${esc(email)}`;
    $('modalNombre').type = 'text';
    $('modalNombre').placeholder = 'Código de verificación';
    $('modalNombre').value = '';
    $('modalNombre').maxLength = 6;
    $('modalNombre').style.textAlign = 'center';
    $('modalNombre').style.fontSize = '1.5rem';
    $('modalNombre').style.letterSpacing = '8px';
    $('modalEmail').style.display = 'none';
    document.querySelector('#modalRegistro .btn-primary').textContent = '✅ Verificar código';
}

function setModalRetiroStep() {
    $('modalTitle').textContent = '🏦 Datos bancarios';
    $('modalDesc').textContent = '¿A dónde querés recibir la plata?';
    $('modalNombre').type = 'text';
    $('modalNombre').placeholder = 'Alias (ej: mialias.mp)';
    $('modalNombre').value = '';
    $('modalEmail').type = 'text';
    $('modalEmail').placeholder = 'CBU (opcional si ponés alias)';
    $('modalEmail').value = '';
    $('modalEmail').style.display = '';
    document.querySelector('#modalRegistro .btn-primary').textContent = '✅ Retirar';
}

function cerrarModal() {
    $('modalRegistro').classList.remove('open');
    modalCallback = null;
}

function confirmarRegistro() {
    const btn = document.querySelector('#modalRegistro .btn-primary');
    const text = btn.textContent;

    if (text === '📩 Enviar código') {
        const email = $('modalEmail').value.trim();
        if (!email) { mostrarToast('Ingresá tu email', 'error'); return; }
        if (modalCallback) modalCallback(email); // -> envía código, pasa al paso verificar
        return;
    }

    if (text === '✅ Verificar código') {
        const codigo = $('modalNombre').value.trim();
        if (!codigo || codigo.length < 4) { mostrarToast('Ingresá el código de verificación', 'error'); return; }
        if (modalCallback) modalCallback(codigo);
        cerrarModal();
        return;
    }

    if (text === '✅ Retirar') {
        if (modalCallback) modalCallback($('modalNombre').value.trim(), $('modalEmail').value.trim());
        cerrarModal();
        return;
    }

    // Confirmación generica (sin inputs): simularPago, confirmarEntrega, abrirDisputa
    if (modalCallback) modalCallback();
    cerrarModal();
}

// --- SESIÓN ---
function ingresarUsuario(u) {
    APP.usuario = u;
    localStorage.setItem('aval_token', u.token || '');
    localStorage.setItem('aval_user_id', u.id);
    actualizarUI();
}
function logoutSilencioso() {
    APP.usuario = null;
    localStorage.removeItem('aval_token');
    localStorage.removeItem('aval_user_id');
    actualizarUI();
}

// --- HAMBURGER MENU ---
function toggleMenu() { $('mobileMenu').classList.toggle('open'); }

// --- NAVEGACIÓN ---
function showPage(page) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-links a').forEach(a => a.classList.remove('active'));
    const pageEl = $(`page-${page}`);
    if (pageEl) pageEl.classList.add('active');
    const navLink = document.querySelector(`.nav-links a[onclick*="${page}"]`);
    if (navLink) navLink.classList.add('active');
    if (page === 'mis-transacciones') cargarTransacciones();
    if (page === 'crear-cadena') cargarCadenaSelector();
    window.scrollTo(0, 0);
}

// --- MONEDA ---
function formatPesos(n) {
    return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 0 }).format(n || 0);
}

// --- COMISIONES (client side preview) ---
function mostrarCalcResultado(montoEl, opts) {
    const montoStr = (montoEl?.value || '').replace(/[^0-9]/g, '');
    const monto = parseInt(montoStr) || 0;
    const fee = Math.round(monto * 0.02);
    const wrap = $(opts.wrap);
    if (!monto || monto < 50000) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'block';
    $(opts.comp).textContent = formatPesos(fee);
    $(opts.vend).textContent = formatPesos(fee);
    if (opts.showTotals) {
        $(opts.totC).textContent = formatPesos(monto + fee);
        $(opts.totV).textContent = formatPesos(monto - fee);
    }
}
function calcularComisionManual() {
    mostrarCalcResultado($('calcMonto'), { wrap: 'calcResultado', comp: 'calcComision', vend: 'calcTotal' });
}
function actualizarComisionPreview() {
    mostrarCalcResultado($('monto'), {
        wrap: 'comisionPreview', comp: 'comisionValorComprador', vend: 'comisionValorVendedor',
        totC: 'comisionTotalComprador', totV: 'comisionTotalVendedor', showTotals: true
    });
}

// --- ESTADOS ---
const ESTADOS = {
    'pendiente_pago':     { label: '⏳ Pendiente de pago',     class: 'badge-pendiente' },
    'pendiente_deposito': { label: '💸 Pendiente de depósito', class: 'badge-pendiente' },
    'depositado':         { label: '🔒 Fondos retenidos',      class: 'badge-depositado' },
    'completado':         { label: '✅ Completado',            class: 'badge-completado' },
    'disputa':            { label: '⚖️ En disputa',            class: 'badge-disputa' },
    'reembolsado':        { label: '↩️ Reembolsado',           class: 'badge-reembolsado' },
    'cancelado':          { label: '🗑️ Cancelado',             class: 'badge-pendiente' },
    'pendiente':          { label: '📄 Pendiente',             class: 'badge-pendiente' }
};

// ============================================
// INICIALIZACIÓN
// ============================================
document.addEventListener('DOMContentLoaded', async () => {
    // Auto-login con el token de sesión del localStorage
    const token = localStorage.getItem('aval_token');
    if (token) {
        try {
            const u = await API.me();
            u.token = token;
            ingresarUsuario(u);
        } catch (e) {
            logoutSilencioso();
        }
    }
    actualizarUI();

    // Link de pago compartido: ?pagar=<id>
    const params = new URLSearchParams(window.location.search);
    const pagarId = params.get('pagar');
    if (pagarId) {
        showPage('pagar');
        cargarPaginaPago(pagarId);
        return;
    }
});

// ============================================
// USUARIO
// ============================================
function actualizarUI() {
    const display = $('userDisplay');
    const logoutBtn = $('logoutBtn');
    if (APP.usuario) {
        display.innerHTML = `👤 ${esc(APP.usuario.nombre)} <small style="color:#666">(${esc(APP.usuario.email)})</small>`;
        logoutBtn.style.display = 'inline';
    } else {
        display.innerHTML = '🔑 Ingresar o Registrarse';
        logoutBtn.style.display = 'none';
    }
}

// --- LOGIN / REGISTRO (email + código de verificación) ---
async function registrarOJugar() {
    abrirModal('🔑 Ingresar o Registrarse',
        'Ingresá tu email. Obtendrás un código para entrar. Si no estás registrado, lo creamos a partir del email.',
        '📩 Enviar código',
        async (email) => {
            if (!email) return;
            let data;
            try {
                data = await API.enviarCodigo(email);
            } catch (err) {
                mostrarToast('Error: ' + esc(err.message), 'error');
                cerrarModal();
                return;
            }
            if (data.dev_code) mostrarToast('⚠️ Desarrollo: el código es ' + data.dev_code, 'info');
            setModalCodeStep(email);
            modalCallback = async (codigo) => {
                try {
                    const r = await API.verificarCodigo(email, codigo, '');
                    ingresarUsuario(r);
                    cerrarModal();
                    mostrarToast(`👋 ¡Bienvenido, ${esc(r.nombre)}!`, 'success');
                    showPage('mis-transacciones');
                } catch (err) {
                    mostrarToast('Error: ' + esc(err.message), 'error');
                }
            };
        });
}

function cerrarSesion() {
    API.logout();
    logoutSilencioso();
    showPage('inicio');
    mostrarToast('Sesión cerrada', 'info');
}

// ============================================
// CREAR TRANSACCIÓN
// ============================================
async function crearTransaccion() {
    if (!APP.usuario) {
        mostrarToast('Primero registrate para crear una transacción.', 'info');
        return;
    }

    const btn = document.querySelector('#formCrear button[type="submit"]');
    const originalText = btn.innerHTML;

    const descripcion = $('descripcion').value.trim();
    const montoStr = $('monto').value.trim();
    const vendedorEmail = $('vendedor_email').value.trim();
    const plazo = parseInt($('plazo').value) || 7;

    if (!descripcion || !montoStr || !vendedorEmail) {
        mostrarToast('Completá todos los campos: descripción, monto y email del vendedor.', 'error');
        return;
    }
    const monto = parseInt(montoStr.replace(/\./g, ''));
    if (isNaN(monto) || monto < 50000) {
        mostrarToast('El monto mínimo es $50.000 ARS.', 'error');
        return;
    }

    try {
        btn.disabled = true;
        btn.innerHTML = '⏳ Creando...';

        const result = await API.crearTransaccion({
            monto_ars: monto,
            descripcion,
            vendedor_email: vendedorEmail,
            plazo_dias: plazo
        });

        $('linkPago').value = result.link_pago || '';
        $('txId').textContent = result.id;
        $('txMonto').textContent = formatPesos(result.monto_ars);
        $('txFeeComprador').textContent = formatPesos(result.fee_comprador_ars);
        $('txFeeVendedor').textContent = formatPesos(result.fee_vendedor_ars);
        $('txTotalComprador').textContent = formatPesos(result.monto_ars + result.fee_comprador_ars);
        $('txTotalVendedor').textContent = formatPesos(result.monto_ars - result.fee_vendedor_ars);
        $('resultadoCrear').style.display = 'block';
        $('formCrear').style.display = 'none';
        mostrarToast('✅ Transacción creada con éxito', 'success');
    } catch (err) {
        mostrarToast('Error: ' + esc(err.message), 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
    }
}

// ============================================
// LISTAR TRANSACCIONES
// ============================================
let filtroActual = 'todas';

function filtrarTransacciones(filtro) {
    filtroActual = filtro;
    document.querySelectorAll('.filter-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.filter === filtro);
    });
    cargarTransacciones();
}

async function cargarTransacciones() {
    const container = $('listaTransacciones');
    if (!APP.usuario) {
        container.innerHTML = `<div class="empty-state"><p>🔑 Registrate para ver tus transacciones.</p></div>`;
        return;
    }

    try {
        const txs = await API.listarTransacciones();
        if (!txs || txs.length === 0) {
            container.innerHTML = `<div class="empty-state"><p>📭 Todavía no tenés transacciones. <a href="#" onclick="showPage('crear')">Creá la primera</a></p></div>`;
            return;
        }

        const filtradas = filtroActual === 'todas' ? txs : txs.filter(tx => {
            if (filtroActual === 'pendiente') return String(tx.estado || '').startsWith('pendiente');
            return tx.estado === filtroActual;
        });

        if (filtradas.length === 0) {
            container.innerHTML = `<div class="empty-state"><p>No hay transacciones en este filtro.</p></div>`;
            return;
        }

        container.innerHTML = filtradas.map(tx => `
            <div class="tx-card" onclick="verDetalle('${esc(tx.id)}')">
                <div class="tx-card-left">
                    <h3>${esc(tx.descripcion)}</h3>
                    <p>${esc(tx.vendedor_nombre || tx.vendedor_id)}</p>
                </div>
                <div class="tx-card-right">
                    <div class="monto">${formatPesos(tx.monto_ars)}</div>
                    <span class="badge ${ESTADOS[tx.estado]?.class || 'badge-pendiente'}">${esc(ESTADOS[tx.estado]?.label || tx.estado)}</span>
                </div>
            </div>
        `).join('');
    } catch (err) {
        container.innerHTML = `<div class="empty-state"><p>Error al cargar: ${esc(err.message)}</p></div>`;
    }
}

// ============================================
// DETALLE DE TRANSACCIÓN
// ============================================
function badgeParaEstado(tx) {
    const e = ESTADOS[tx.estado] || { label: esc(tx.estado), class: 'badge-pendiente' };
    return `<span class="badge ${e.class}">${e.label}</span>`;
}

async function verDetalle(id) {
    showPage('detalle');
    const container = $('detalleContent');
    container.innerHTML = '<p class="loading">Cargando...</p>';
    try {
        const tx = await API.obtenerTransaccion(id);
        const esComprador = !!tx.soy_comprador;
        const esVendedor = !!tx.soy_vendedor;
        const esParticipante = esComprador || esVendedor;
        const esRaiz = !tx.parent_id;

        // Acuerdos de la ronda actual (disputa) - solo mostrar a participantes
        const acuerdosHtml = (tx.acuerdos_resumen || []).map(a =>
            `<span class="acuerdo-parte">${esc(a.nombre)}: ✓ aceptó ${a.ganador_vendedor ? 'liberar el pago al vendedor' : 'reemborsar al comprador'}</span>`
        ).join('<br>');

        let acciones = '';
        if (esRaiz && esComprador && tx.estado === 'depositado') {
            acciones += `<button class="btn btn-success" onclick="confirmarEntrega('${esc(tx.id)}')">✅ Confirmar entrega</button>`;
        }
        if (esParticipante && tx.estado === 'depositado') {
            acciones += `<button class="btn btn-danger" onclick="abrirDisputa('${esc(tx.id)}')">⚖️ Abrir disputa</button>`;
        }
        if (tx.estado === 'disputa' && esParticipante) {
            acciones += `<div class="acuerdos-box">
                <div class="acuerdo-row">💵 <b>Reembolso a mí:</b></div>
                <button class="btn btn-warning" onclick="aceptarAcuerdoDisputa('${esc(tx.id)}', false)">📩 Aceptar reembolso</button>
            </div>
            <div class="acuerdos-box">
                <div class="acuerdo-row">✅ <b>Liberar pago al vendedor:</b></div>
                <button class="btn btn-success" onclick="aceptarAcuerdoDisputa('${esc(tx.id)}', true)">📩 Aceptar liberar</button>
            </div>
            ${acuerdosHtml ? '<p class="texto-ayuda">Confirmaciones:<br>' + acuerdosHtml + '</p>' : ''}`;
            if (APP.usuario?.es_admin) {
                acciones += `<button class="btn btn-outline" onclick="resolverDisputeAdmin('${esc(tx.id)}', true)">🔧 Resolver: liberar pago</button>`;
                acciones += `<button class="btn btn-outline" onclick="resolverDisputeAdmin('${esc(tx.id)}', false)">🔧 Resolver: reemborsar</button>`;
            }
        }
        if (tx.estado === 'completado' && esVendedor && tx.monto_retiro) {
            const falta = tx.retiro_solicitado ? '' : ' — Aún no se lo pediste a tu banco';
            acciones += `<button class="btn btn-primary" onclick="solicitarRetiro('${esc(tx.id)}')">💰 Retirar ${formatPesos(tx.monto_retiro)}${falta}</button>`;
        }

        container.innerHTML = `
            <div class="detalle-card">
                <div class="detalle-header">
                    <h2>${esc(tx.descripcion)}</h2>
                    ${badgeParaEstado(tx)}
                </div>
                <div class="detalle-info">
                    <div class="detalle-row"><span class="label">ID</span><span class="value">${esc(tx.id)}</span></div>
                    <div class="detalle-row"><span class="label">Comprador</span><span class="value">${esc(tx.comprador_nombre)}${tx.comprador_email ? ' (' + esc(tx.comprador_email) + ')' : ''}</span></div>
                    <div class="detalle-row"><span class="label">Vendedor</span><span class="value">${esc(tx.vendedor_nombre)}${tx.vendedor_email ? ' (' + esc(tx.vendedor_email) + ')' : ''}</span></div>
                    <div class="detalle-row"><span class="label">Monto producto</span><span class="value">${formatPesos(tx.monto_ars)}</span></div>
                    <div class="detalle-row"><span class="label">🔵 Fee comprador (2%)</span><span class="value">${formatPesos(tx.fee_comprador_ars)}</span></div>
                    <div class="detalle-row"><span class="label">🟢 Fee vendedor (2%)</span><span class="value">${formatPesos(tx.fee_vendedor_ars)}</span></div>
                    ${tx.parent_id ? `<div class="detalle-row"><span class="label">🔗 Eslabón de cadena</span><span class="value">Raíz #${esc(tx.raiz_id)}; hijo: ${esc(tx.chain_child_id || 'ninguno')}${tx.monto_hijo ? ' (' + formatPesos(tx.monto_hijo) + ')' : ''}</span></div>` : ''}
                    <div class="detalle-row"><span class="label">💰 Comprador paga</span><span class="value" style="color:var(--danger)">${formatPesos(tx.monto_ars + (tx.fee_comprador_ars || 0))}</span></div>
                    <div class="detalle-row"><span class="label">💵 Vendedor recibe</span><span class="value" style="color:var(--success)">${formatPesos(tx.monto_retiro || (tx.monto_ars - (tx.fee_vendedor_ars || 0) - (tx.monto_hijo || 0)))}</span></div>
                    ${tx.link_pago ? `<div class="detalle-row"><span class="label">Link de pago</span><span class="value" style="font-size:0.8rem;word-break:break-all">${esc(tx.link_pago)}</span></div>` : ''}
                </div>
                ${acciones ? `<div class="detalle-actions">${acciones}</div>` : ''}
            </div>
        `;

        if (tx.estado === 'pendiente_pago') await cargarDatosBancarios(tx);
    } catch (err) {
        container.innerHTML = `<p>Error: ${esc(err.message)}</p>`;
    }
}

async function cargarDatosBancarios(tx) {
    const container = $('detalleContent');
    try {
        const config = await API.obtenerDatosPago();
        const totalPagado = tx.monto_ars + (tx.fee_comprador_ars || 0);
        container.innerHTML += `
            <div class="acciones-card">
                <h3>🏦 Datos para transferir</h3>
                <div class="banco-info">
                    <div class="banco-row"><span class="banco-label">Banco</span><span class="banco-valor">${esc(config.banco)}</span></div>
                    <div class="banco-row"><span class="banco-label">Titular</span><span class="banco-valor">${esc(config.titular)}</span></div>
                    <div class="banco-row"><span class="banco-label">CUIT</span><span class="banco-valor">${esc(config.cuit)}</span></div>
                    <div class="banco-row"><span class="banco-label">Alias</span><span class="banco-valor alias-destacado" onclick="copiarTexto('${esc(config.alias)}')">${esc(config.alias)} 📋</span></div>
                    <div class="banco-row"><span class="banco-label">CBU</span><span class="banco-valor" onclick="copiarTexto('${esc(config.cbu)}')">${esc(config.cbu)} 📋</span></div>
                    <div class="banco-row"><span class="banco-label">Referencia</span><span class="banco-valor" onclick="copiarTexto('AVAL-${esc(tx.id)}')">AVAL-${esc(tx.id)} 📋</span></div>
                </div>
                <p style="color:var(--gray-500);font-size:0.85rem">⚠️ Transferí exactamente <strong>${formatPesos(totalPagado)}</strong></p>
                <button class="btn btn-primary btn-block" style="margin-top:12px" onclick="notificarPago('${esc(tx.id)}')">✅ Ya transferí — Notificar pago</button>
            </div>
        `;
    } catch (err) {
        console.error('Error al cargar datos bancarios:', err);
    }
}

function copiarTexto(texto) {
    navigator.clipboard.writeText(texto).then(() => {
        mostrarToast('✅ Copiado al portapapeles', 'success');
    }).catch(() => {
        mostrarToast('Error al copiar', 'error');
    });
}

// ============================================
// PAGO NOTIFICADO
// ============================================
async function notificarPago(transaccionId) {
    const tx = await API.obtenerTransaccion(transaccionId);
    if (!APP.usuario || !tx.soy_comprador) {
        mostrarToast('Registrate o ingresá con el email del comprador para notificar el pago', 'info');
        registrarOJugar();
        return;
    }
    if (tx.estado !== 'pendiente_pago') {
        mostrarToast('El pago ya está retenido', 'info');
        await verDetalle(transaccionId);
        return;
    }
    try {
        await API.notificarPago(transaccionId);
        mostrarToast('✅ Pago notificado. Los fondos están retenidos.', 'success');
        await verDetalle(transaccionId);
    } catch (err) {
        mostrarToast('Error: ' + esc(err.message), 'error');
    }
}

// ============================================
// CONFIRMAR ENTREGA
// ============================================
async function confirmarEntrega(id) {
    mostrarConfirmacion('¿Confirmás que recibiste el producto y está todo bien? Esto liberará el pago al vendedor.', async () => {
        try {
            await API.confirmarEntrega(id);
            mostrarToast('✅ Entrega confirmada. Pago liberado al vendedor.', 'success');
            await verDetalle(id);
        } catch (err) {
            mostrarToast('Error: ' + esc(err.message), 'error');
        }
    });
}

// ============================================
// DISPUTAS (acuerdo por ronda: ambas partes)
// ============================================
async function aceptarAcuerdoDisputa(id, ganadorVendedor) {
    mostrarConfirmacion('¿Confirmás tu acuerdo?', async () => {
        try {
            const r = await API.aceptarAcuerdoDisputa(id, { ganador_vendedor: ganadorVendedor, usuario_id: APP.usuario.id });
            if (r.resuelto) {
                mostrarToast('✅ Disputa resuelta: ' + (r.estado === 'completado' ? 'pago liberado al vendedor' : 'reembolso registrado'), 'success');
            } else {
                mostrarToast('Esperando que la otra parte acepte', 'info');
            }
            await verDetalle(id);
        } catch (err) {
            mostrarToast('Error: ' + esc(err.message), 'error');
        }
    });
}

async function resolverDisputeAdmin(id, ganadorVendedor) {
    const quien = ganadorVendedor ? 'liberar el pago al vendedor' : 'reemborsar al comprador';
    mostrarConfirmacion(`🔧 Resolver definitivamente como admin: ${quien}`, async () => {
        try {
            await API.resolverDisputeAdmin(id, { ganador_vendedor: ganadorVendedor });
            mostrarToast('✅ Disputa resuelta (forzada)', 'success');
            await verDetalle(id);
        } catch (err) {
            mostrarToast('Error: ' + esc(err.message), 'error');
        }
    });
}

async function abrirDisputa(id) {
    mostrarConfirmacion('¿Estás seguro de abrir una disputa? El pago quedará congelado hasta que se resuelva.', async () => {
        try {
            await API.abrirDisputa(id);
            mostrarToast('⚖️ Disputa abierta. Nos pondremos en contacto.', 'info');
            await verDetalle(id);
        } catch (err) {
            mostrarToast('Error: ' + esc(err.message), 'error');
        }
    });
}

// ============================================
// PÁGINA DE PAGO (link compartido ?pagar=id)
// ============================================
async function cargarPaginaPago(id) {
    const container = $('pagarContent');
    container.innerHTML = '<p class="loading">Cargando transacción...</p>';
    try {
        const tx = await API.obtenerTransaccion(id);
        const config = await API.obtenerDatosPago();
        const totalPagado = tx.monto_ars + (tx.fee_comprador_ars || 0);

        if (tx.estado !== 'pendiente_pago') {
            container.innerHTML = `
                <div class="pagar-card">
                    <h2>${tx.estado === 'completado' ? '✅ Pago completado' : tx.estado === 'depositado' ? '🔒 Pago recibido' : '❌ Transacción no disponible'}</h2>
                    <p>${esc(tx.descripcion)}</p>
                    <p>${formatPesos(tx.monto_ars)}</p>
                    <p style="color:#666;margin-top:16px">Estado: ${esc(ESTADOS[tx.estado]?.label || tx.estado)}</p>
                    ${APP.usuario ? `<p style="margin-top:12px"><a href="#" onclick="showPage('mis-transacciones');return false" style="color:var(--primary)">📋 Ver mi historial</a></p>` : ''}
                </div>
            `;
            return;
        }

        container.innerHTML = `
            <div class="pagar-card">
                <div class="pagar-header">
                    <h2>🛡️ Pago seguro con AvalEscrow</h2>
                    <p style="color:#666">Transacción protegida por contrato inteligente en Polygon</p>
                </div>
                <div class="pagar-detalle">
                    <div class="pagar-row"><span>Producto</span><span class="pagar-valor">${esc(tx.descripcion)}</span></div>
                    <div class="pagar-row"><span>Vendedor</span><span class="pagar-valor">${esc(tx.vendedor_nombre)}</span></div>
                    <div class="pagar-row"><span>Monto del producto</span><span class="pagar-valor">${formatPesos(tx.monto_ars)}</span></div>
                    <div class="pagar-row"><span>Comisión (2%)</span><span class="pagar-valor">${formatPesos(tx.fee_comprador_ars)}</span></div>
                    <div class="pagar-row pagar-total">
                        <span><strong>TOTAL A TRANSFERIR</strong></span>
                        <span class="pagar-valor pagar-monto-grande"><strong>${formatPesos(totalPagado)}</strong></span>
                    </div>
                </div>
                <div class="pagar-banco">
                    <h3>🏦 Transferí a esta cuenta</h3>
                    <div class="banco-info">
                        <div class="banco-row"><span class="banco-label">Banco</span><span class="banco-valor">${esc(config.banco)}</span></div>
                        <div class="banco-row"><span class="banco-label">Titular</span><span class="banco-valor">${esc(config.titular)}</span></div>
                        <div class="banco-row"><span class="banco-label">CUIT</span><span class="banco-valor">${esc(config.cuit)}</span></div>
                        <div class="banco-row"><span class="banco-label">🔤 Alias</span><span class="banco-valor alias-destacado" onclick="copiarTexto('${esc(config.alias)}')">${esc(config.alias)} 📋</span></div>
                        <div class="banco-row"><span class="banco-label">🔢 CBU</span><span class="banco-valor" onclick="copiarTexto('${esc(config.cbu)}')">${esc(config.cbu)} 📋</span></div>
                        <div class="banco-row"><span class="banco-label">📝 Referencia</span><span class="banco-valor" onclick="copiarTexto('AVAL-${esc(tx.id)}')">AVAL-${esc(tx.id)} 📋</span></div>
                    </div>
                </div>
                <div class="pagar-accion">
                    <p style="font-size:0.9rem;color:var(--danger);margin-bottom:12px">⚠️ Transferí exactamente <strong>${formatPesos(totalPagado)}</strong> usando el alias.</p>
                    <button class="btn btn-primary btn-lg" onclick="notificarPago('${esc(tx.id)}')">✅ Ya transferí — Notificar pago</button>
                    <p style="font-size:0.8rem;color:#999;margin-top:8px">
                        ${APP.usuario ? 'Necesitás estar logueado con tu email para avisar.' : 'Ingresá con tu email y nuestro código para avisar.'}
                    </p>
                </div>
                <p style="font-size:0.8rem;color:var(--gray-400);margin-top:16px;text-align:center">🔒 Protegido por AvalEscrow</p>
            </div>
        `;
    } catch (err) {
        container.innerHTML = `
            <div class="pagar-card">
                <h2>❌ Transacción no encontrada</h2>
                <p>Este link no es válido o la transacción expiró.</p>
            </div>
        `;
    }
}

// ============================================
// CADENA SELECTOR
// ============================================
async function cargarCadenaSelector() {
    if (!APP.usuario) return;
    try {
        const txs = await API.listarTransacciones();
        const pendientes = txs.filter(tx => tx.estado === 'depositado' && !tx.parent_id && !tx.chain_child_id);
        const select = $('cadena_origen');
        if (select) {
            select.innerHTML = '<option value="">Seleccionar transacción...</option>' +
                pendientes.map(tx => `<option value="${esc(tx.id)}">#${esc(tx.id.slice(0, 8))} - ${esc(tx.descripcion)} (${formatPesos(tx.monto_ars)})</option>`).join('');
        }
    } catch (err) {
        console.error('Error al cargar selector de cadena:', err);
    }
}

async function crearEslabon() {
    if (!APP.usuario) {
        mostrarToast('Primero registrate para crear una cadena.', 'info');
        return;
    }
    const txOrigenId = $('cadena_origen').value;
    const vendedorEmail = $('cadena_vendedor_email').value.trim();
    const vendedorNombre = $('cadena_vendedor_nombre').value.trim();
    const montoStr = $('cadena_monto').value.trim();
    const descripcion = $('cadena_descripcion')?.value.trim() || 'Eslabón de cadena';
    const plazo = parseInt($('cadena_plazo').value) || 7;

    if (!txOrigenId || !vendedorEmail || !montoStr) {
        mostrarToast('Completá todos los campos requeridos', 'error');
        return;
    }
    const monto = parseInt(montoStr.replace(/\./g, ''));
    if (isNaN(monto) || monto < 50000) {
        mostrarToast('El monto mínimo es $50.000 ARS.', 'error');
        return;
    }

    const btn = document.querySelector('#formCadena button[type="submit"]');
    try {
        btn.disabled = true;
        btn.innerHTML = '⏳ Creando eslabón...';
        const result = await API.crearEslabonCadena({
            tx_origen_id: txOrigenId,
            vendedor_email: vendedorEmail,
            vendedor_nombre: vendedorNombre,
            monto_ars: monto,
            descripcion,
            plazo_dias: plazo
        });
        $('cadenaInfo').textContent = `✅ Eslabón creado: #${result.id} - ${esc(result.descripcion)} (${formatPesos(result.monto_ars)})`;
        $('resultadoCadena').style.display = 'block';
        $('formCadena').style.display = 'none';
        mostrarToast('✅ Eslabón creado con éxito', 'success');
    } catch (err) {
        mostrarToast('Error: ' + esc(err.message), 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = 'Crear eslabón'; }
    }
}

function crearOtroEslabon() {
    $('resultadoCadena').style.display = 'none';
    $('formCadena').style.display = 'block';
    $('formCadena').reset();
    cargarCadenaSelector();
}

// ============================================
// COMISIONES (backend)
// ============================================
async function calcularComisiones() {
    const montoStr = $('calcMonto').value.trim();
    const monto = parseInt(montoStr.replace(/\./g, ''));
    if (isNaN(monto) || monto < 50000) {
        $('calcResultado').innerHTML = `<p style="color:var(--danger)">El monto mínimo es $50.000 ARS</p>`;
        return;
    }
    try {
        const data = await API.calcularComisiones(monto);
        $('calcResultado').innerHTML = `
            <div class="calc-grid">
                <div class="calc-item">
                    <span class="calc-label">Comprador paga</span>
                    <span class="calc-valor">${formatPesos(data.total_comprador)}</span>
                    <small>(${formatPesos(data.monto)} + ${formatPesos(data.fee_comprador)} comisión)</small>
                </div>
                <div class="calc-item">
                    <span class="calc-label">Vendedor recibe</span>
                    <span class="calc-valor">${formatPesos(data.total_vendedor)}</span>
                    <small>(${formatPesos(data.monto)} - ${formatPesos(data.fee_vendedor)} comisión)</small>
                </div>
            </div>
        `;
    } catch (err) {
        $('calcResultado').innerHTML = `<p style="color:var(--danger)">Error: ${esc(err.message)}</p>`;
    }
}

function copiarLink() {
    const link = $('linkPago').value.trim();
    if (!link) { mostrarToast('No hay link de pago para copiar', 'error'); return; }
    navigator.clipboard.writeText(link).then(() => {
        mostrarToast('✅ Link copiado al portapapeles', 'success');
    }).catch(() => {
        mostrarToast('Error al copiar', 'error');
    });
}

// ============================================
// RETIRAR FONDOS (solo vendedor, solo completado)
// ============================================
async function solicitarRetiro(id) {
    abrirModal('💰 Retirar fondos',
        'Ingresá los datos de la cuenta donde querés recibir el dinero:',
        '✅ Retirar',
        async () => {});
    setModalRetiroStep();
    modalCallback = async (alias, cbu) => {
        try {
            const result = await API.retirarFondos(id, {
                alias: alias || null,
                cbu: cbu || null
            });
            mostrarToast(result.mensaje || '✅ Retiro solicitado', 'success');
            await verDetalle(id);
        } catch (err) {
            mostrarToast('Error: ' + esc(err.message), 'error');
        }
    };
}

// ============================================
// CONFIRMACIÓN GENÉRICA (modal sin inputs)
// ============================================
function mostrarConfirmacion(mensaje, callback) {
    $('modalTitle').textContent = '⚠️ Confirmar';
    $('modalDesc').textContent = mensaje;
    $('modalNombre').value = '';
    $('modalEmail').value = '';
    $('modalNombre').style.display = 'none';
    $('modalEmail').style.display = 'none';
    document.querySelector('#modalRegistro .btn-primary').textContent = '✅ Confirmar';
    modalCallback = callback;
    $('modalRegistro').classList.add('open');
}
