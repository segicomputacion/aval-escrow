/**
 * Smoke test del backend AvalEscrow v2 (off-chain).
 * Corre:  node smoke-backend.js
 */
const BASE = process.env.BASE_URL || 'http://localhost:3002';
let fallos = 0;
// Suffijo por ejecución: los rate-limit de login (429) bloquean reintentos
const S = (process.env.SMOKE_SUFFIX || Date.now() % 100000).toString();

function ok(cond, msg) {
    if (cond) console.log('  OK  ', msg);
    else { fallos++; console.log('  FAIL', msg); }
}
async function get(path, token) {
    const r = await fetch(BASE + path, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
    return { status: r.status, data: await r.json().catch(() => ({})) };
}
async function post(path, body, token) {
    const r = await fetch(BASE + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: JSON.stringify(body || {})
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
}
async function loginEmail(email) {
    const r1 = await post('/api/usuarios/enviar-codigo', { email });
    if (!r1.data.dev_code) throw new Error('no dev_code para ' + email + ': ' + JSON.stringify(r1.data));
    const r2 = await post('/api/usuarios/verificar-codigo', { email, codigo: r1.data.dev_code });
    if (!r2.data.token) throw new Error('login falló para ' + email + ': ' + JSON.stringify(r2.data));
    return r2.data;
}

(async () => {
    console.log('💉 Smoke test del backend (AvalEscrow v2) — sufijo ' + S + '\n');

    // 0. health
    {
        const h = await get('/health');
        ok(h.status === 200 && h.data.ok, 'GET /health -> ok');
        const h2 = await get('/api/health');
        ok(h2.status === 200, 'GET /api/health -> ok');
        const me = await get('/api/usuarios/me');
        ok(me.status === 401, 'me sin token -> 401');
        const tx = await post('/api/transacciones', { vendedor_email: 'a@b.c', descripcion: 'x', monto_ars: 100 });
        ok(tx.status === 401, 'crear tx sin token -> 401');
    }

    // 1. login
    const B = {
        comprador: await loginEmail('comprador1' + S + '@aval.test'),
        vendedor: await loginEmail('vendedor1' + S + '@aval.test'),
        c: await loginEmail('c1' + S + '@aval.test')
    };
    ok(B.comprador.token && B.vendedor.token && B.c.token, 'login: token recibido');
    ok((await get('/api/usuarios/me', B.comprador.token)).status === 200, 'me -> 200');
    ok((await get('/api/usuarios/me', B.comprador.token)).data.password === undefined, 'me -> password oculto');

    // 2. crear transacción simple (raíz)
    let tx1;
    {
        const r = await post('/api/transacciones', {
            vendedor_email: 'vendedor1' + S + '@aval.test',
            descripcion: 'Notebook HP Display - smoke test',
            monto_ars: 50000, plazo_dias: 7
        }, B.comprador.token);
        ok(r.status === 200 && r.data.id, 'crear tx1: ' + JSON.stringify(r.data).slice(0, 100));
        tx1 = r.data;
        ok(tx1.link_pago.includes('pagar=' + tx1.id), 'link_pago contiene el id');
        ok(tx1.estado === 'pendiente_pago', 'estado inicial pendiente_pago');

        const rv = await post('/api/transacciones', { vendedor_email: 'v@aval.test', descripcion: 'y', monto_ars: 1000 }, B.comprador.token);
        ok(rv.status === 400, 'monto < 50000 -> 400');
        const rb = await post('/api/transacciones', { vendedor_email: 'comprador1' + S + '@aval.test', descripcion: 'self', monto_ars: 100000 }, B.comprador.token);
        ok(rb.status === 400, 'vendedor == comprador -> 400');

        const p = await post('/api/webhook/pago', { transaccion_id: tx1.id }, B.comprador.token);
        ok(p.status === 200 && p.data.estado === 'depositado', 'webhook pago -> depositado');
        const pb = await post('/api/webhook/pago', { transaccion_id: tx1.id }, B.comprador.token);
        ok(pb.status === 409, 'webhook doble -> 409');
        const pv = await post('/api/webhook/pago', { transaccion_id: tx1.id }, B.vendedor.token);
        ok(pv.status === 403, 'webhook por vendedor -> 403');
    }

    // 3. confirmar simple -> completado
    {
        const r = await post('/api/transacciones/' + tx1.id + '/confirmar', {}, B.comprador.token);
        ok(r.status === 200 && r.data.estado === 'completado', 'confirmar raiz -> completado: ' + JSON.stringify(r.data).slice(0, 120));

        const d = await get('/api/transacciones/' + tx1.id, B.vendedor.token);
        ok(d.status === 200, 'detalle tx1 por vendedor -> 200');
        ok(d.data.soy_vendedor === true && d.data.soy_comprador === false, 'soy_vendedor true, soy_comprador false');
        ok(d.data.monto_retiro === 49000, 'monto_retiro: ' + d.data.monto_retiro);
        const dN = await get('/api/transacciones/' + tx1.id, B.c.token);
        ok(dN.status === 200 && dN.data.comprador_email === undefined, 'detalle público: sin email del comprador');

        const rr = await post('/api/transacciones/' + tx1.id + '/retirar', { alias: 'mi.alias', cbu: '0123456789' }, B.vendedor.token);
        ok(rr.status === 200 && rr.data.success, 'retirar -> solicitado: ' + JSON.stringify(rr.data).slice(0, 120));
        const dr = await get('/api/transacciones/' + tx1.id, B.vendedor.token);
        ok(dr.data.retiro_solicitado === true, 'detalle: retiro_solicitado');
    }

    // 4. cadena: root2 (comprador=B, vendedor=v2<S>) -> hijo (comprador=v2<S>, vendedor=v2b<S>)
    let root2, child2, v2User, v2bUser;
    {
        const r = await post('/api/transacciones', { vendedor_email: 'v2' + S + '@aval.test', descripcion: 'Raiz de cadena', monto_ars: 100000, plazo_dias: 7 }, B.comprador.token);
        root2 = r.data;
        ok(root2.id, 'root2 creada');
        await post('/api/webhook/pago', { transaccion_id: root2.id }, B.comprador.token);

        v2User = await loginEmail('v2' + S + '@aval.test');
        v2bUser = await loginEmail('v2b' + S + '@aval.test');
        const c = await post('/api/transacciones/cadena', {
            tx_origen_id: root2.id, vendedor_email: 'v2b' + S + '@aval.test', vendedor_nombre: 'C', monto_ars: 60000, descripcion: 'eslabon del smoke', plazo_dias: 7
        }, v2User.token); // origen.vendedor == v2User
        ok(c.status === 200 && c.data.parent_id === root2.id, 'creado eslabón hijo: ' + JSON.stringify(c.data).slice(0, 140));
        child2 = c.data;
        ok(child2.comprador_id === v2User.id, 'hijo: comprador = v2 (vendedor del padre)');

        const dRoot = await get('/api/transacciones/' + root2.id, B.comprador.token);
        ok(dRoot.data.chain_child_id === child2.id && dRoot.data.monto_hijo === 60000, 'raíz: chain_child_id + monto_hijo=60000');
        const dHijo = await get('/api/transacciones/' + child2.id, v2User.token);
        ok(dHijo.data.estado === 'depositado', 'hijo nace depositado (no requiere depósito)');
        ok(dHijo.data.soy_comprador && !dHijo.data.soy_vendedor, 'soy_comprador=true, soy_vendedor=false');

        const c2 = await post('/api/transacciones/cadena', { tx_origen_id: root2.id, vendedor_email: 'x@y.z', monto_ars: 1000, descripcion: 'x' }, v2User.token);
        ok(c2.status === 409, 'segundo hijo -> 409');
        const c3 = await post('/api/transacciones/cadena', { tx_origen_id: child2.id, vendedor_email: 'x@y.z', monto_ars: 70000, descripcion: 'x' }, v2bUser.token);
        ok(c3.status === 400, 'monto excedente en el hijo -> 400 (max 60000)');

        const rc = await post('/api/transacciones/' + root2.id + '/confirmar', {}, B.comprador.token);
        ok(rc.status === 200 && rc.data.estado === 'completado', 'cadena: confirmar raíz');

        const dC = await get('/api/transacciones/' + child2.id, v2bUser.token); // v2b es vendedor del hijo
        ok(dC.data.monto_retiro === 60000 - Math.round(60000 * 0.02), 'monto_retiro del hijo: ' + dC.data.monto_retiro);
        const dV2 = await get('/api/transacciones/' + root2.id, v2User.token);
        ok(dV2.data.monto_retiro === 100000 - 2000 - 60000, 'monto_retiro de v2 (raíz): ' + dV2.data.monto_retiro);
    }

    // 5. disputa: acuerdo doble — comprador raíz + vendedor raíz
    {
        const r = await post('/api/transacciones', { vendedor_email: 'v3' + S + '@aval.test', descripcion: 'Disputa doble', monto_ars: 50000 }, B.comprador.token);
        const rootId = r.data.id;
        await post('/api/webhook/pago', { transaccion_id: rootId }, B.comprador.token);

        const d1 = await post('/api/transacciones/' + rootId + '/disputa', { motivo: 'producto roto' }, B.comprador.token);
        ok(d1.status === 200 && d1.data.estado === 'disputa', 'disputa abierta');

        const a1 = await post('/api/transacciones/' + rootId + '/aceptar-acuerdo', { ganador_vendedor: true }, B.comprador.token);
        ok(a1.status === 200 && a1.data.resuelto === false, 'comprador aceptó (falta v3): ' + JSON.stringify(a1.data));

        const v3User = await loginEmail('v3' + S + '@aval.test');
        const a2 = await post('/api/transacciones/' + rootId + '/aceptar-acuerdo', { ganador_vendedor: true }, v3User.token);
        ok(a2.status === 200 && a2.data.resuelto === true, 'v3 aceptó → resuelto: ' + JSON.stringify(a2.data));
        ok((await get('/api/transacciones/' + rootId, B.comprador.token)).data.estado === 'completado', 'estado: completado');
    }

    // 6. disputa refund (reembolso): admin
    {
        const r = await post('/api/transacciones', { vendedor_email: 'v4' + S + '@aval.test', descripcion: 'Disputa refund', monto_ars: 50000 }, B.comprador.token);
        const rootId = r.data.id;
        await post('/api/webhook/pago', { transaccion_id: rootId }, B.comprador.token);
        await post('/api/transacciones/' + rootId + '/disputa', {}, B.comprador.token);

        const admin = await loginEmail('admin@avalescrow.com');
        const ame = await get('/api/usuarios/me', admin.token);
        ok(ame.status === 200 && ame.data.es_admin, 'admin login + es_admin: ' + JSON.stringify(ame.data).slice(0, 100));
        const rr = await post('/api/admin/transacciones/' + rootId + '/resolver', { ganador_vendedor: false }, admin.token);
        ok(rr.status === 200, 'admin resuelve (reembolso): ' + JSON.stringify(rr.data).slice(0, 80));
        ok((await get('/api/transacciones/' + rootId, B.comprador.token)).data.estado === 'reembolsado', 'estado: reembolsado');
    }

    // 7. logout
    {
        const r = await post('/api/usuarios/logout', {}, B.comprador.token);
        ok(r.status === 200, 'logout');
        ok((await get('/api/usuarios/me', B.comprador.token)).status === 401, 'token invalidado tras logout');
    }

    console.log(fallos === 0 ? '\n✅ TODOS LOS SMOKE TESTS PASAN' : '\n❌ FALLOS: ' + fallos);
    process.exit(fallos === 0 ? 0 : 1);
})().catch(e => {
    console.error('Smoke test ERROR:', e);
    process.exit(1);
});
