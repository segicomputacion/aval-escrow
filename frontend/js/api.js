/* ============================================
   AVAL ESCROW v2 - API CLIENT (autenticada)
   ============================================ */
const API = {
    BASE_URL: window.location.origin,

    // Token de sesión almacenado en el localStorage por login/registro/código.
    _token: () => localStorage.getItem('aval_token'),

    _headers(extra) {
        const h = { 'Content-Type': 'application/json' };
        const t = API._token();
        if (t) h['Authorization'] = 'Bearer ' + t;
        return { ...h, ...extra };
    },

    async _post(path, data) {
        const res = await fetch(this.BASE_URL + path, {
            method: 'POST',
            headers: this._headers(),
            body: JSON.stringify(data || {})
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `Error al hacer la llamada (${res.status})`);
        }
        return res.json();
    },

    // ---------- Autenticación ----------
    async enviarCodigo(email) {
        const res = await fetch(`${this.BASE_URL}/api/usuarios/enviar-codigo`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Error al enviar el código');
        return data;
    },

    async verificarCodigo(email, codigo, nombre) {
        const res = await fetch(`${this.BASE_URL}/api/usuarios/verificar-codigo`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, codigo, nombre })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Error al verificar el código');
        return data;
    },

    async logout() {
        try { await API._post('/api/usuarios/logout', {}); } catch {}
        localStorage.removeItem('aval_token');
        localStorage.removeItem('aval_user_id');
    },

    async login(email, password) { return API._post('/api/usuarios/login', { email, password }); },
    async registro(email, nombre, password) { return API._post('/api/usuarios/registro', { email, nombre, password }); },
    async me() { return API._get('/api/usuarios/me'); },

    async _get(path) {
        const res = await fetch(this.BASE_URL + path, {
            headers: this._headers()
        });
        if (!res.ok) throw new Error('Error al consultar (' + res.status + ')');
        return res.json();
    },

    // ---------- Transacciones ----------
    async crearTransaccion(data) {
        return API._post('/api/transacciones', data);
    },

    async crearEslabonCadena(data) {
        return API._post('/api/transacciones/cadena', data);
    },

    async listarTransacciones() {
        return API._get('/api/transacciones');
    },

    async obtenerTransaccion(id) {
        return API._get(`/api/transacciones/${id}`);
    },

    async confirmarEntrega(id) {
        return API._post(`/api/transacciones/${id}/confirmar`, {});
    },

    async abrirDisputa(id, motivo) {
        return API._post(`/api/transacciones/${id}/disputa`, { motivo });
    },

    async aceptarAcuerdoDisputa(id, { ganador_vendedor, usuario_id }) {
        return API._post(`/api/transacciones/${id}/aceptar-acuerdo`, { ganador_vendedor, usuario_id });
    },

    async resolverDisputaAdmin(id, { ganador_vendedor }) {
        return API._post(`/api/admin/transacciones/${id}/resolver`, { ganador_vendedor });
    },

    async notificarPago(id) {
        return API._post('/api/webhook/pago', { transaccion_id: id, metodo: 'transferencia' });
    },

    async retirarFondos(id, data) {
        return API._post(`/api/transacciones/${id}/retirar`, data);
    },

    async obtenerDatosPago() {
        return API._get('/api/config/datos-pago');
    },

    async calcularComisiones(monto) {
        return API._post('/api/comisiones/calcular', { monto });
    }
};
