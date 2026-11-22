// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title AvalEscrow
 * @notice Escrow con soporte de CADENA DE PAGOS (A -> B -> C ...)
 * @dev Deployado por la plataforma. Toda creación es solo-plataforma;
 *      el árbitro de cada eslabón es la plataforma.
 *
 * MODELO DE FONDOS:
 * - Solo el eslabón RAÍZ recibe depósito (USDT del comprador raíz).
 * - Un eslabón hijo se crea con monto <= disponible del padre
 *   (disponible = padre.monto - padre.chainDownstreamAmt) y nace ya
 *   en estado DEPOSITADO: su valor está cubierto por el depósito raíz.
 * - Al crear el hijo, se marca en el PADRE chainDownstreamAmt = monto_hijo
 *   ("esta plata está comprometida con el siguiente eslabón").
 * - Al liberar en cascada: cada eslabón paga a su vendedor
 *   (monto - chainDownstreamAmt) y el último paga todo lo suyo.
 *   Por telescopio, la suma de pagos = monto del raíz. Sin fondos fantasma.
 * - Reembolso: siempre se devuelve monto_raiz al comprador raíz.
 *
 * FLUJO (ej A->B->C):
 * 1. plataforma.crearEscrow(A, B, USDT, 1000, desc, 7d)      -> E1 CREADO
 * 2. A aprueba USDT y llama depositar(E1)                     -> E1 DEPOSITADO
 * 3. plataforma.crearEscrowEnCadena(B, C, USDT, 700, ..., E1) -> E2 DEPOSITADO,
 *    E1.chainDownstreamAmt = 700, E1.chainChildId = E2
 * 4. A llama confirmarEntrega(E1) -> se libera la cadena:
 *    C recibe 700, B recibe 300 (1000 - 700)
 * 5. Disputa: cualquiera de las partes de un eslabón congela TODA la cadena;
 *    la plataforma (árbitro) resuelve liberando o reembolsando toda la cadena.
 * 6. Si nadie actúa, tras el plazo del RAÍZ:
 *    - el comprador raíz (o sus partes) reclama reembolso: reclamarVencido
 *    - o la plataforma abre/resuelve disputa
 *
 * NOTA: Las comisiones (2% comprador + 2% vendedor) se manejan off-chain
 * en el backend, al convertir ARS<->USDT. El contrato solo retiene y
 * libera USDT sin ningún descuento.
 *
 * USDT Polygon: 0xc2132D05D31c914a87C6611C10748AEb04B58e8F
 */
contract AvalEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------- TIPOS ----------
    // (ENTREGADO y EXPIRADO eliminados: nunca se usaban)
    enum Estado { CREADO, DEPOSITADO, COMPLETADO, DISPUTA, REEMBOLSADO, CANCELADO }

    struct Transaccion {
        uint256 id;
        address comprador;
        address vendedor;
        address arbitro;          // siempre la plataforma (creador)
        address token;
        uint256 monto;            // monto total de este eslabón
        string descripcion;
        uint256 plazo;            // timestamp límite (gobierna el depósito RAÍZ)
        Estado estado;
        uint256 createdAt;
        // === CAMPOS DE CADENA ===
        uint256 chainParentId;      // 0 = eslabón inicial (donde se deposita)
        uint256 chainChildId;       // 0 = último eslabón
        uint256 chainDownstreamAmt; // porción de monto comprometida con el hijo
                                    // (se setea al crear el hijo = monto del hijo)
    }

    // ---------- ESTADO ----------
    /// @notice Wallet que despliega el contrato: única que crea escrows
    ///         y única que puede resolver disputas (árbitro).
    address public immutable plataforma;

    uint256 public nextId = 1;
    /// @notice Total de USDT retenidos como responsabilidad del contrato.
    ///         Se incrementa al depositar y decrementa al liberar/reembolsar.
    ///         Permite checks de saldo por contrato (no por saldo global crudo).
    uint256 public fondosRetenidos;

    mapping(uint256 => Transaccion) public transacciones;
    mapping(address => uint256[]) public transaccionesDe;

    // Eventos
    event EscrowCreado(uint256 indexed id, address indexed comprador, address indexed vendedor, uint256 monto, address token);
    event EscrowEnCadena(uint256 indexed id, uint256 indexed parentId, uint256 downstreamAmount);
    event DepositoRealizado(uint256 indexed id, address indexed comprador, uint256 monto);
    event EntregaConfirmada(uint256 indexed id);
    event TransaccionCompletada(uint256 indexed id, address indexed vendedor, uint256 montoRecibido);
    event DisputaAbierta(uint256 indexed id, address indexed quien);
    event ArbitrajeResuelto(uint256 indexed id, address ganador, uint256 monto);
    event Reembolsado(uint256 indexed id, uint256 monto);
    event Cancelado(uint256 indexed id);
    event CadenaCompletada(uint256 indexed idRaiz);

    // ---------- MODIFIERS ----------
    modifier soloPlataforma() {
        require(msg.sender == plataforma, "Solo la plataforma puede crear/resolver");
        _;
    }

    modifier soloEstado(uint256 _id, Estado _estado) {
        require(transacciones[_id].estado == _estado, "Estado incorrecto para esta accion");
        _;
    }

    // ---------- CONSTRUCTOR ----------
    constructor() {
        plataforma = msg.sender;
    }

    // ---------- FUNCIONES: CREACIÓN ----------

    /**
     * @notice Crear un escrow simple (sin cadena). Solo la plataforma.
     * @dev La plataforma actúa como árbitro de todos los eslabones.
     */
    function crearEscrow(
        address _comprador,
        address _vendedor,
        address _token,
        uint256 _monto,
        string calldata _descripcion,
        uint256 _plazoEnDias
    ) external soloPlataforma returns (uint256) {
        require(_comprador != address(0), "Comprador invalido");
        require(_vendedor != address(0), "Vendedor invalido");
        require(_comprador != _vendedor, "Comprador y vendedor no pueden ser la misma direccion");
        require(_token != address(0), "Token invalido");
        require(_monto > 0, "Monto debe ser mayor a 0");
        require(_plazoEnDias > 0 && _plazoEnDias <= 90, "Plazo entre 1 y 90 dias");

        return _crearEscrowBase(_comprador, _vendedor, _token, _monto, _descripcion, _plazoEnDias);
    }

    /**
     * @notice Crear el eslabón siguiente de una cadena. Solo la plataforma.
     * @dev El comprador del hijo debe ser el vendedor del padre (el dinero
     *      fluye en la misma dirección que la mercadería).
     *      El hijo nace DEPOSITADO: su valor ya está cubierto por el
     *      depósito del raíz. No requiere (ni permite) nuevo depósito.
     *      No acepta _downstreamAmount: al crearse el hijo se marca en el
     *      padre chainDownstreamAmt = _monto, que es exactamente lo que el
     *      padre debe dejar de pagarle a su vendedor.
     */
    function crearEscrowEnCadena(
        address _comprador,
        address _vendedor,
        address _token,
        uint256 _monto,
        string calldata _descripcion,
        uint256 _plazoEnDias,
        uint256 _parentEscrowId
    ) external soloPlataforma nonReentrant returns (uint256) {
        require(_parentEscrowId > 0 && _parentEscrowId < nextId, "Parent escrow invalido");
        require(_comprador != address(0) && _vendedor != address(0), "Partes invalidas");
        require(_comprador != _vendedor, "Comprador y vendedor no pueden ser la misma direccion");
        require(_token != address(0), "Token invalido");
        require(_monto > 0, "Monto debe ser mayor a 0");
        require(_plazoEnDias > 0 && _plazoEnDias <= 90, "Plazo entre 1 y 90 dias");

        Transaccion storage parent = transacciones[_parentEscrowId];
        require(parent.chainChildId == 0, "Parent ya tiene un eslabon hijo");
        require(parent.estado == Estado.DEPOSITADO, "Parent debe estar depositado primero");
        // Invariante contable: el hijo no puede exceder lo no comprometido del padre.
        // Como el padre solo puede tener UN hijo, chainDownstreamAmt del padre es 0
        // acá, pero la resta deja el listo para reintentos/futuras extensiones.
        require(_monto <= parent.monto - parent.chainDownstreamAmt, "Monto excede lo disponible del parent");
        // El comprador del hijo es el vendedor del padre: el que recibe la plata
        // del eslabón anterior es el que compra el siguiente.
        require(_comprador == parent.vendedor, "El comprador de este eslabon debe ser el vendedor del parent");
        // No se puede extender una cadena congelada por disputa.
        require(parent.estado == Estado.DEPOSITADO, "Parent en disputa o cancelado");

        uint256 id = _crearEscrowBase(_comprador, _vendedor, _token, _monto, _descripcion, _plazoEnDias);

        // El hijo nace ya cubierto por el depósito raíz.
        Transaccion storage nuevo = transacciones[id];
        nuevo.estado = Estado.DEPOSITADO;
        nuevo.chainParentId = _parentEscrowId;

        // Marcar en el padre: este monto queda comprometido con el hijo.
        parent.chainDownstreamAmt = _monto;
        parent.chainChildId = id;

        emit EscrowEnCadena(id, _parentEscrowId, _monto);
        return id;
    }

    function _crearEscrowBase(
        address _comprador,
        address _vendedor,
        address _token,
        uint256 _monto,
        string calldata _descripcion,
        uint256 _plazoEnDias
    ) internal returns (uint256) {
        uint256 id = nextId++;
        uint256 plazo = block.timestamp + (_plazoEnDias * 1 days);

        transacciones[id] = Transaccion({
            id: id,
            comprador: _comprador,
            vendedor: _vendedor,
            arbitro: plataforma,
            token: _token,
            monto: _monto,
            descripcion: _descripcion,
            plazo: plazo,
            estado: Estado.CREADO,
            createdAt: block.timestamp,
            chainParentId: 0,
            chainChildId: 0,
            chainDownstreamAmt: 0
        });

        transaccionesDe[_comprador].push(id);
        transaccionesDe[_vendedor].push(id);

        emit EscrowCreado(id, _comprador, _vendedor, _monto, _token);
        return id;
    }

    // ---------- FUNCIONES: DEPÓSITO Y CONFIRMACIÓN ----------

    /**
     * @notice Depositar fondos en un escrow RAÍZ.
     * @dev El comprador debe aprobar el token primero. Los eslabones en
     *      cadena no se depositan (nacen cubiertos por el raíz).
     */
    function depositar(uint256 _id) external nonReentrant soloEstado(_id, Estado.CREADO) {
        Transaccion storage t = transacciones[_id];
        require(msg.sender == t.comprador, "Solo el comprador puede depositar");
        require(t.chainParentId == 0, "Los eslabones en cadena no requieren deposito");

        IERC20 token = IERC20(t.token);
        token.safeTransferFrom(msg.sender, address(this), t.monto);

        t.estado = Estado.DEPOSITADO;
        fondosRetenidos += t.monto;
        emit DepositoRealizado(_id, msg.sender, t.monto);
    }

    /**
     * @notice Confirmar entrega del eslabón RAÍZ y liberar toda la cadena.
     * @dev Solo el comprador raíz puede hacerlo, y solo desde el raíz.
     *      Esto evita que un eslabón intermedio libere los fondos del raíz
     *      sin que el comprador original haya confirmado.
     */
    function confirmarEntrega(uint256 _id) external nonReentrant {
        Transaccion storage t = transacciones[_id];
        require(t.estado == Estado.DEPOSITADO, "Estado incorrecto para esta accion");
        require(t.chainParentId == 0, "Confirmar desde el eslabon inicial de la cadena");
        require(msg.sender == t.comprador, "Solo el comprador puede confirmar");

        _liberarCadena(_id);

        emit EntregaConfirmada(_id);
    }

    // ---------- FUNCIONES: DISPUTA ----------

    /**
     * @notice Abrir disputa (congela TODA la cadena).
     * @dev Puede cualquier participante (comprador o vendedor) de cualquier
     *      eslabón. El congelamiento es un estado seguro: no se liberan ni
     *      reembolsan fondos hasta que la plataforma resuelva.
     */
    function abrirDisputa(uint256 _id) external soloEstado(_id, Estado.DEPOSITADO) {
        Transaccion storage t = transacciones[_id];
        require(msg.sender == t.comprador || msg.sender == t.vendedor, "Solo comprador o vendedor");
        _congelarCadena(_id);
        emit DisputaAbierta(_id, msg.sender);
    }

    /**
     * @notice Resolver disputa (solo la plataforma, árbitro de todos los eslabones).
     * @param _ganadorVendedor true = libera toda la cadena, false = reembolsa al comprador raíz
     */
    function resolverDisputa(uint256 _id, bool _ganadorVendedor)
        external
        nonReentrant
        soloEstado(_id, Estado.DISPUTA)
    {
        Transaccion storage t = transacciones[_id];
        require(msg.sender == t.arbitro, "Solo el arbitro puede resolver");

        uint256 raiz = _raizDe(_id);

        if (_ganadorVendedor) {
            _liberarCadena(raiz);
            emit ArbitrajeResuelto(_id, t.vendedor, transacciones[raiz].monto);
        } else {
            _reembolsarDesdeRaiz(raiz);
            emit ArbitrajeResuelto(_id, transacciones[raiz].comprador, transacciones[raiz].monto);
        }
    }

    // ---------- FUNCIONES: EXPIRACIÓN ----------

    /**
     * @notice Cancelar un escrow aún no pagado (solo la plataforma/creador).
     */
    function cancelarPorExpiracion(uint256 _id) external soloEstado(_id, Estado.CREADO) {
        transacciones[_id].estado = Estado.CANCELADO;
        emit Cancelado(_id);
    }

    /**
     * @notice Reclamar reembolso tras el plazo del RAÍZ.
     * @dev El plazo que gobierna es el del eslabón raíz (el que hizo el
     *      depósito). Cualquier parte del raíz o la plataforma puede
     *      llamarlo; el dinero siempre vuelve al comprador raíz.
     *      Esto garantiza que los fondos no quedan bloqueados para siempre.
     */
    function reclamarVencido(uint256 _id) external nonReentrant {
        Transaccion storage t = transacciones[_id];
        require(t.estado == Estado.DEPOSITADO, "Estado incorrecto para esta accion");

        uint256 raiz = _raizDe(_id);
        Transaccion storage r = transacciones[raiz];
        require(
            msg.sender == r.comprador || msg.sender == r.vendedor || msg.sender == r.arbitro,
            "Solo partes del eslabon raiz o el arbitro"
        );
        require(block.timestamp > r.plazo, "Aun no vencio el plazo");

        _reembolsarDesdeRaiz(raiz);
    }

    // ---------- FUNCIONES: CONSULTA ----------

    function verEstado(uint256 _id) external view returns (Estado) {
        return transacciones[_id].estado;
    }

    function verTransaccion(uint256 _id) external view returns (Transaccion memory) {
        return transacciones[_id];
    }

    function verTransaccionesDe(address _usuario) external view returns (uint256[] memory) {
        return transaccionesDe[_usuario];
    }

    /**
     * @notice Obtener la cadena completa (raíz -> último) desde cualquier eslabón.
     */
    function verCadenaCompleta(uint256 _id) external view returns (uint256[] memory) {
        uint256 raiz = _raizDe(_id);

        // Contar eslabones
        uint256 count = 1;
        uint256 current = raiz;
        while (transacciones[current].chainChildId != 0) {
            current = transacciones[current].chainChildId;
            count++;
        }

        // Llenar array
        uint256[] memory result = new uint256[](count);
        current = raiz;
        for (uint256 i = 0; i < count; i++) {
            result[i] = current;
            current = transacciones[current].chainChildId;
        }

        return result;
    }

    // ---------- FUNCIONES INTERNAS ----------

    function _raizDe(uint256 _id) internal view returns (uint256) {
        uint256 raiz = _id;
        // nextId es cota superior del número de eslabones: el bucle termina.
        while (transacciones[raiz].chainParentId != 0) {
            raiz = transacciones[raiz].chainParentId;
        }
        return raiz;
    }

    /**
     * @dev Libera la cadena completa empezando por el ÚLTIMO eslabón.
     *      Cada eslabón paga a su vendedor (monto - comprometido con su hijo).
     *      Por telescopio, la suma de pagos = monto raíz.
     *      Idempotente: los eslabones ya COMPLETADO/REEMBOLSADO se saltean.
     */
    function _liberarCadena(uint256 _id) internal {
        Transaccion storage t = transacciones[_id];

        // 1. Si tiene hijo, liberarlo primero (cascada hacia abajo)
        if (t.chainChildId != 0) {
            _liberarCadena(t.chainChildId);
        }

        // 2. Liberar este eslabón (si todavía está pendiente)
        if (t.estado != Estado.DEPOSITADO && t.estado != Estado.DISPUTA) {
            return; // ya liberado o reembolsado
        }

        uint256 montoVendedor = t.monto - t.chainDownstreamAmt;

        if (montoVendedor > 0) {
            // Check contra la responsabilidad del contrato, no del saldo crudo:
            // así otros escrows activos no "prestan" saldo a este chequeo.
            require(fondosRetenidos >= montoVendedor, "Saldo insuficiente en el contrato");
            fondosRetenidos -= montoVendedor;
            IERC20(t.token).safeTransfer(t.vendedor, montoVendedor);
        }

        t.estado = Estado.COMPLETADO;
        emit TransaccionCompletada(_id, t.vendedor, montoVendedor);

        // Si es la raíz, emitir evento de cadena completa
        if (t.chainParentId == 0) {
            emit CadenaCompletada(_id);
        }
    }

    /**
     * @dev Reembolsa la raíz de la cadena (o un escrow simple) al comprador.
     */
    function _reembolsarDesdeRaiz(uint256 _raizId) internal {
        Transaccion storage raiz = transacciones[_raizId];

        // Marcar toda la cadena como reembolsada (idempotente)
        _marcarCadenaReembolsada(_raizId);

        require(fondosRetenidos >= raiz.monto, "Saldo insuficiente en el contrato");
        fondosRetenidos -= raiz.monto;
        IERC20(raiz.token).safeTransfer(raiz.comprador, raiz.monto);

        emit Reembolsado(_raizId, raiz.monto);
    }

    function _marcarCadenaReembolsada(uint256 _raizId) internal {
        uint256 current = _raizId;
        while (current != 0) {
            Transaccion storage t = transacciones[current];
            if (t.estado == Estado.DEPOSITADO || t.estado == Estado.DISPUTA) {
                t.estado = Estado.REEMBOLSADO;
            }
            current = t.chainChildId;
        }
    }

    function _congelarCadena(uint256 _id) internal {
        // Subir hasta la raíz
        uint256 current = _id;
        while (current != 0) {
            Transaccion storage t = transacciones[current];
            if (t.estado == Estado.DEPOSITADO) {
                t.estado = Estado.DISPUTA;
            }
            current = t.chainParentId;
        }

        // Bajar hasta el último hijo
        current = transacciones[_id].chainChildId;
        while (current != 0) {
            Transaccion storage t = transacciones[current];
            if (t.estado == Estado.DEPOSITADO) {
                t.estado = Estado.DISPUTA;
            }
            current = t.chainChildId;
        }
    }

    receive() external payable {
        revert("Este contrato solo maneja tokens ERC-20, no ETH");
    }
}
