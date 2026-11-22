# 🛡️ AvalEscrow v2 — Cadena de Pagos

**Plataforma de escrow sobre blockchain para compra-venta entre particulares en Argentina, con soporte de CADENA DE PAGOS.**

---

## 🎯 ¿Qué problema resuelve?

**Simple:** A compra algo, paga con garantía. Cuando recibe, se libera la plata.

**Cadena:** A le compra a B, y B usa esos mismos fondos retenidos para pagarle a C. Cuando A confirma, se libera todo en cascada automáticamente.

> ⚠️ **Nota de honestidad v2:** en esta versión el backend es **off-chain** (transacciones en `database.json`). El contrato `AvalEscrow.sol` está desplegado y preparado, pero la integración on-chain (conversión ARS↔USDT, depósito real) se implementará en una siguiente fase. El flujo actual (bank transfer en ARS + notificación + verificación) funciona hoy sin crypto.

### Ejemplo real (agro):

> **Productor** → vende soja a **Acopiador** → que le compra insumos a **Proveedor**
>
> 1. Productor pone $1.000.000 en el escrow
> 2. Acopiador (que sabe que ya hay $1.000.000 retenidos) genera un eslabón por $700.000 para pagarle a su proveedor de fertilizantes
> 3. Productor recibe la soja, confirma → se liberan $1.000.000 al acopiador y $700.000 al proveedor **en la misma operación**
> 4. Si hay disputa, el árbitro resuelve toda la cadena de una

---

## 📦 Estructura del proyecto

```
escrow-app/
├── contracts/
│   ├── src/Escrow.sol              ← Contrato inteligente (con cadena)
│   ├── src/mocks/MockUSDT.sol      ← Mock para tests
│   ├── test/Escrow.test.js         ← Tests (32, todos pasando)
│   ├── hardhat.config.js           ← Network amoy (testnet vigente)
│   └── package.json
├── backend/
│   ├── server.js                   ← API REST (Express + auth por token)
│   ├── package.json
│   └── data/                       ← DB empaquetada (docker volume): database.json
├── frontend/
│   ├── index.html                  ← Interfaz web (vanilla JS, sin build)
│   ├── css/style.css
│   └── js/
│       ├── api.js                  ← Conexión con backend (Bearer tokens)
│       └── app.js                  ← Lógica de la app
├── scripts/deploy.js               ← Deploy del contrato
├── .env.example
├── .gitignore
├── Dockerfile
└── README.md                       ← Este archivo
```

---

## 🧠 Smart Contract (`contracts/src/Escrow.sol`)

### Estados de una transacción

```
CREADO → DEPOSITADO → COMPLETADO
                ↓            ↑
            DISPUTA ────────┘
                ↓
         REEMBOLSADO / CANCELADO
```

### Modelo de fondos (importante)

- **Solo el eslabón raíz recibe depósito** (USDT del comprador).
- Un eslabón hijo se crea **ya con estado `DEPOSITADO`**: su valor está cubierto por el depósito del raíz. No requiere (y no permite) nuevo depósito.
- Al crear un hijo, el padre marca `chainDownstreamAmt = monto del hijo` ("esta plata está comprometida con el siguiente eslabón").
- Al liberar en cascada, cada eslabón paga a su vendedor: `monto - chainDownstreamAmt`. **Por telescopio, la suma de pagos = monto del raíz → sin dinero aplazado ni doblecounting.**
- Reembolso: siempre se devuelve el monto completo al comprador del raíz.

### Funciones principales (todas solo-plataforma)

| Función | Quién la llama | Qué hace |
|---------|---------------|----------|
| `crearEscrow(...)` | Plataforma | Crea el escrow simple. Rechaza comprador==vendedor. |
| `crearEscrowEnCadena(...)` | Plataforma | Crea el siguiente eslabón. El comprador del hijo debe ser el vendedor del padre. El hijo nace depositado. |
| `depositar(id)` | Comprador del raíz | Deposita los USDT (sender autorizado; transferFrom). |
| `confirmarEntrega(id)` | Comprador del raíz | Libera toda la cadena. **Solo desde el raíz** (un eslabón intermedio no puede liberar el dinero del raíz sin el OK de A). |
| `abrirDisputa(id)` | Comprador o vendedor de cualquier eslabón | Congela TODA la cadena. |
| `resolverDisputa(id, ganadorVendedor)` | Árbitro (la plataforma) | Libera toda la cadena o reemborsa el monto del raíz. |
| `reclamarVencido(id)` | any eslabón | Reembolso tras el plazo del RAÍZ. El plazo del raíz es el que gobierna el depósito. |
| `verCadenaCompleta(id)` | Anyone (view) | Devuelve [raíz → último eslabón]. |

### Lista de errores de seguridad corregidos v2

- [x] **Árbitro por parte del creador** → árbitro = plataforma (account deployer).
- [x] **Reentrancy**: release/depósito hacían `token.transfer()` antes de actualizar el estado → `ReentrancyGuard` (OZ).
- [x] **Token arbitrario** → `SafeERC20.safeTransferFrom/safeTransfer`.
- [x] **Contabilidad de cadena rota** → `fondosRetenidos` (responsabilidad del contrato); checks contra esta, no `balanceOf` global.
- [x] **Confirmación por eslabón intermedio** → `confirmarEntrega` exige raíz; solo quien libera es el comprador raíz.
- [x] **Matemática de cadena**: `crearEscrowEnCadena` exige `child.monto <= parent.monto - parent.chainDownstreamAmt` (el ejemplo del README funciona).
- [x] **Reembolso género** → solo partes del raíz o el árbitro.
- [x] **Plazo inconsistente** → el plazo del raíz gobierna.
- [x] Eliminación de estados muertos (`ENTREGADO`, `EXPIRADO`).

---

## ⚙️ Backend API (`backend/server.js`)

Toda mutación exige autenticación: `Authorization: Bearer <token>` (devuelto por login/registro/código). El usuario en el body no se usa; el servidor lo obtiene del token.

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/usuarios/enviar-codigo` | Envía código por email (SMTP). En dev sin SMTP devuelve `dev_code`. |
| POST | `/api/usuarios/verificar-codigo` | Verifica código → usuario + `token` de sesión |
| POST | `/api/usuarios/registro` | Registro por password → `{user, token}` |
| POST | `/api/usuarios/login` | Login por password → `{user, token}` |
| POST | `/api/usuarios/logout` | Invalida token de sesión |
| GET | `/api/usuarios/me` | Datos del usuario autenticado |
| POST | `/api/transacciones` | Crear transacción raíz. Resuelve vendedor por email. Min $50.000. Devuelve `link_pago`. |
| POST | `/api/transacciones/cadena` | Crear eslabón. Validaciónes: un solo hijo, monto disponible, comprador_del_hijo == vendedor_del_padre. Crea ya como depositado. |
| GET | `/api/transacciones` | Mis transacciones (con nombres). |
| GET | `/api/transacciones/:id` | Detalle: participante → emails, link, retiro disponible, acuerdos. Link público → sin emails ni ids. |
| POST | `/api/transacciones/:id/confirmar` | Confirmar entrega del raíz (comprador). Libera cadena. |
| POST | `/api/transacciones/:id/disputa` | Abrir disputa (participantes). Congela cadena. |
| POST | `/api/transacciones/:id/aceptar-acuerdo` | Acepta acuerdo en ronda; resolve solo cuando ambas partes aceptan mismo resultado (comprador raíz en liberar). |
| POST | `/api/admin/transacciones/:id/resolver` | Resolver definitivamente (admin). |
| GET | `/api/admin/disputas` | Listar disputas activas (admin). |
| POST | `/api/webhook/pago` | Notificar pago (comprador). `pendiente_pago → depositado`. |
| POST | `/api/transacciones/:id/retirar` | Solicitar retiro (vendedor, solo en completado). |
| GET | `/api/config/datos-pago` | Datos bancarios actuales. |
| GET | `/api/comisiones` / `/api/comisiones/calcular` | 2% + 2% ARS. |
| GET | `/health`, `/api/health` | Health check |

**Detalles de implementación:**

- **Rate limiting**: login, registro, verificación, envío de código (429 si te pasas).
- **DB**: `database.json` escritura atómica (tmp + rename).
- **Admin**: cuenta solo si `ADMIN_PASSWORD` está en `.env` (sin defaults).
- **Security headers**: `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.
- **CORS**: deshabilitado por defecto; si se sirve frontend dedicado: `CORS_ORIGIN=<origen>`.
- **Logging**: request logging mínimo.
- **Descarga de noche:** (dev tools) - haceló mas barato

---

## 🚀 Cómo levantar todo

### 1. Deploy del contrato (opcional hoy; integración on-chain en próxima fase)

```bash
cd escrow-app/contracts
npm install
npx hardhat compile
npx hardhat test
# Despliegue a Amoy (testnet vigente)
npx hardhat run ../scripts/deploy.js --network amoy
```

### 2. Backend

```bash
cd escrow-app/backend
cp .env.example .env
# EDITAR: ADMIN_PASSWORD, SMTP_* si querés email real
npm install
npm start
```

> 💡 En desarrollo sin SMTP, la API devuelve el código en la respuesta (`dev_code`). En producción, SMTP es obligatorio para loguear.

### 3. Frontend

Abrir `escrow-app/frontend/index.html` en el navegador, o `npx serve .`. Si el backend no está en el mismo origen: `CORS_ORIGIN=<tu-origen>`.

---

## 🚀 Deploy en Railway (recomendado)

1. Sube el código a GitHub y creá un repo.
2. Railway → New Project → Deploy from GitHub.
3. Variables de entorno: `ADMIN_PASSWORD` (obligatorio para admin), `SMTP_*`, `CORS_ORIGIN` (si es necesario).
4. ❗❗❗ **IMPORTANTE (persistencia):** Railway empieza containers efímeros. **Mount** a la image o declará un volumen en `/app/backend/data`.
5. URL del deploy.

---

## 🧪 Pruebas

```bash
cd contracts
npm install
npx hardhat test
# Resultado esperado: 32 passing
```

---

## 💰 Comisiones

Modelo: **2% comprador + 2% vendedor** (cobrado off-chain, al convertir ARS↔USDT).

| Ejemplo ($100.000) | Importe |
|--------------------|---------|
| Comprador paga | $102.000 (producto + 2% fee) |
| Vendedor recibe | $98.000 (producto - 2% fee) |
| Plataforma | Retiene **$4.000** total (2% de compra + 2% de venta) |

*(En cadenas: el fee de comprador solo se aplica al eslabón raíz; cada eslabón paga su fee de vendedor.)*

| Servicio | Comisión | Argentina |
|----------|----------|-----------|
| MercadoLibre | 10-16% | ✅ Sí |
| Escrow.com | 0.9-3% | ❌ No |
| Trustap | 0.5-1.5% | ❌ No |
| **AvalEscrow** | **2% + 2%** | **✅ Sí** |

---

## ⚠️ Seguridad

- **Autenticación obligatoria** (token Bearer, validado server-side): login/registro/código, modificaciones. Consultas públicas: link de pago, datos bancarios, fees.
- Cuenta admin sin default credenciales (requiere ADMIN_PASSWORD).
- Eslabones en cadena nacen depositados.
- Fondos con límite de expiración (reclamo manual tras plazo).
- Escritura atómica de DB, rate limiting, headers, CORS acotado.

## 🇦🇷 Hecho en Argentina

Hecho por Aval para Sebastián Gismondi (SEGI Computación).
