const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Los tests usan MockUSDT (6 decimales) en lugar de la dirección real de
// Polygon: en la red de hardhat no hay código en 0xc213... y todo revertía.
const DECIMALS = 6;
const toUnits = (n) => ethers.parseUnits(String(n), DECIMALS);

describe("AvalEscrow v2 - Cadena de Pagos", function () {
  let escrow, usdt;
  let plataforma, comprador, vendedor, proveedor, tercero, outsider;
  const MONTO = toUnits(1000);
  const HIJO = toUnits(700);
  const NIETO = toUnits(300);
  const PLAZO = 7;

  beforeEach(async function () {
    [plataforma, comprador, vendedor, proveedor, tercero, outsider] =
      await ethers.getSigners();

    const MockUSDT = await ethers.getContractFactory("MockUSDT");
    usdt = await MockUSDT.deploy();
    await usdt.waitForDeployment();

    const AvalEscrow = await ethers.getContractFactory("AvalEscrow");
    escrow = await AvalEscrow.deploy(); // plataforma = deployer
    await escrow.waitForDeployment();

    // Fondear y aprobar al comprador raíz
    await usdt.mint(comprador.address, toUnits(100000));
    await usdt.connect(comprador).approve(escrow.target, toUnits(100000));
  });

  async function crearRaiz() {
    await escrow.crearEscrow(
      comprador.address,
      vendedor.address,
      usdt.target,
      MONTO,
      "Producto principal",
      PLAZO
    );
    return 1;
  }

  async function depositarRaiz() {
    const id = await crearRaiz();
    await escrow.connect(comprador).depositar(id);
    return id;
  }

  describe("Creación", function () {
    it("crea un escrow correctamente", async function () {
      const id = await crearRaiz();
      const t = await escrow.verTransaccion(id);
      expect(t.comprador).to.equal(comprador.address);
      expect(t.vendedor).to.equal(vendedor.address);
      expect(t.monto).to.equal(MONTO);
      expect(t.estado).to.equal(0); // CREADO
      expect(t.arbitro).to.equal(plataforma.address); // árbitro = plataforma
      expect(t.chainParentId).to.equal(0);
      expect(t.chainDownstreamAmt).to.equal(0);
    });

    it("rechaza monto 0", async function () {
      await expect(
        escrow.crearEscrow(
          comprador.address,
          vendedor.address,
          usdt.target,
          0,
          "Invalido",
          PLAZO
        )
      ).to.be.revertedWith("Monto debe ser mayor a 0");
    });

    it("rechaza plazo mayor a 90 días", async function () {
      await expect(
        escrow.crearEscrow(
          comprador.address,
          vendedor.address,
          usdt.target,
          MONTO,
          "Mucho plazo",
          100
        )
      ).to.be.revertedWith("Plazo entre 1 y 90 dias");
    });

    it("rechaza comprador == vendedor", async function () {
      await expect(
        escrow.crearEscrow(
          comprador.address,
          comprador.address,
          usdt.target,
          MONTO,
          "Self",
          PLAZO
        )
      ).to.be.revertedWith("Comprador y vendedor no pueden ser la misma direccion");
    });

    it("solo la plataforma puede crear (nadie más)", async function () {
      await expect(
        escrow
          .connect(outsider)
          .crearEscrow(
            comprador.address,
            vendedor.address,
            usdt.target,
            MONTO,
            "Hack",
            PLAZO
          )
      ).to.be.revertedWith("Solo la plataforma puede crear/resolver");
    });

    it("rechaza ETH nativo", async function () {
      await expect(
        plataforma.sendTransaction({ to: escrow.target, value: 1 })
      ).to.be.revertedWith(
        "Este contrato solo maneja tokens ERC-20, no ETH"
      );
    });
  });

  describe("Depósito", function () {
    it("el comprador deposita y los fondos quedan retenidos", async function () {
      const id = await crearRaiz();
      await expect(escrow.connect(comprador).depositar(id))
        .to.emit(escrow, "DepositoRealizado")
        .withArgs(id, comprador.address, MONTO);

      const t = await escrow.verTransaccion(id);
      expect(t.estado).to.equal(1); // DEPOSITADO
      expect(await escrow.fondosRetenidos()).to.equal(MONTO);
      expect(await usdt.balanceOf(escrow.target)).to.equal(MONTO);
    });

    it("rechaza depósito de quien no es comprador", async function () {
      const id = await crearRaiz();
      await expect(
        escrow.connect(vendedor).depositar(id)
      ).to.be.revertedWith("Solo el comprador puede depositar");
    });

    it("rechaza doble depósito", async function () {
      const id = await depositarRaiz();
      await expect(escrow.connect(comprador).depositar(id)).to.be.revertedWith(
        "Estado incorrecto para esta accion"
      );
    });
  });

  describe("Liberación simple", function () {
    it("el comprador confirma y el vendedor recibe el monto", async function () {
      const id = await depositarRaiz();

      await expect(escrow.connect(comprador).confirmarEntrega(id))
        .to.emit(escrow, "TransaccionCompletada")
        .withArgs(id, vendedor.address, MONTO);

      expect(await usdt.balanceOf(vendedor.address)).to.equal(MONTO);
      expect(await escrow.fondosRetenidos()).to.equal(0);
      const t = await escrow.verTransaccion(id);
      expect(t.estado).to.equal(2); // COMPLETADO
    });

    it("rechaza confirmación de quien no es comprador", async function () {
      const id = await depositarRaiz();
      await expect(
        escrow.connect(vendedor).confirmarEntrega(id)
      ).to.be.revertedWith("Solo el comprador puede confirmar");
    });
  });

  describe("Cadena de pagos", function () {
    it("crea un eslabón hijo correctamente (monto y vínculos)", async function () {
      const idE1 = await depositarRaiz();

      await escrow.crearEscrowEnCadena(
        vendedor.address,
        proveedor.address,
        usdt.target,
        HIJO,
        "Insumo para el producto",
        PLAZO,
        idE1
      );
      const idE2 = 2;

      const e1 = await escrow.verTransaccion(idE1);
      const e2 = await escrow.verTransaccion(idE2);

      expect(e1.chainChildId).to.equal(idE2);
      // El padre marca lo comprometido con el hijo
      expect(e1.chainDownstreamAmt).to.equal(HIJO);
      expect(e2.chainParentId).to.equal(idE1);
      expect(e2.chainDownstreamAmt).to.equal(0);
      // El hijo nace ya cubierto por el depósito raíz
      expect(e2.estado).to.equal(1); // DEPOSITADO
      // No pide nuevo depósito: el saldo total sigue siendo solo el raíz
      expect(await escrow.fondosRetenidos()).to.equal(MONTO);
    });

    it("rechaza hijo con monto mayor a lo disponible del padre", async function () {
      const idE1 = await depositarRaiz();
      await expect(
        escrow.crearEscrowEnCadena(
          vendedor.address,
          proveedor.address,
          usdt.target,
          toUnits(1500),
          "De más",
          PLAZO,
          idE1
        )
      ).to.be.revertedWith("Monto excede lo disponible del parent");
    });

    it("rechaza hijo si el padre no está depositado", async function () {
      const idE1 = await crearRaiz(); // sin depositar
      await expect(
        escrow.crearEscrowEnCadena(
          vendedor.address,
          proveedor.address,
          usdt.target,
          HIJO,
          "Sin plata",
          PLAZO,
          idE1
        )
      ).to.be.revertedWith("Parent debe estar depositado primero");
    });

    it("rechaza comprador del hijo distinto al vendedor del padre", async function () {
      const idE1 = await depositarRaiz();
      await expect(
        escrow.crearEscrowEnCadena(
          outsider.address, // no es el vendedor del padre
          proveedor.address,
          usdt.target,
          HIJO,
          "Raro",
          PLAZO,
          idE1
        )
      ).to.be.revertedWith(
        "El comprador de este eslabon debe ser el vendedor del parent"
      );
    });

    it("rechaza un segundo hijo para el mismo padre", async function () {
      const idE1 = await depositarRaiz();
      await escrow.crearEscrowEnCadena(
        vendedor.address,
        proveedor.address,
        usdt.target,
        HIJO,
        "Hijo 1",
        PLAZO,
        idE1
      );
      await expect(
        escrow.crearEscrowEnCadena(
          vendedor.address,
          tercero.address,
          usdt.target,
          toUnits(100),
          "Hijo 2",
          PLAZO,
          idE1
        )
      ).to.be.revertedWith("Parent ya tiene un eslabon hijo");
    });

    it("rechaza depositar un eslabón en cadena (ya está cubierto)", async function () {
      const idE1 = await depositarRaiz();
      await escrow.crearEscrowEnCadena(
        vendedor.address,
        proveedor.address,
        usdt.target,
        HIJO,
        "Hijo",
        PLAZO,
        idE1
      );
      // El hijo está en DEPOSITADO: `depositar` exige CREADO y además
      // prohíbe explícitamente depósitos en eslabones de cadena.
      await expect(escrow.connect(vendedor).depositar(2)).to.be.revertedWith(
        "Estado incorrecto para esta accion"
      );
    });

    it("lista la cadena completa", async function () {
      const idE1 = await depositarRaiz();
      await escrow.crearEscrowEnCadena(
        vendedor.address,
        proveedor.address,
        usdt.target,
        HIJO,
        "Hijo",
        PLAZO,
        idE1
      );

      const cadena = await escrow.verCadenaCompleta(idE1);
      expect(cadena.length).to.equal(2);
      expect(cadena[0]).to.equal(idE1);
      expect(cadena[1]).to.equal(2);
    });

    it("rechaza confirmar desde un eslabón intermedio (solo el raíz)", async function () {
      const idE1 = await depositarRaiz();
      await escrow.crearEscrowEnCadena(
        vendedor.address,
        proveedor.address,
        usdt.target,
        HIJO,
        "Hijo",
        PLAZO,
        idE1
      );
      // B (comprador del hijo) intenta liberar la cadena completa sin que A confirme
      await expect(escrow.connect(vendedor).confirmarEntrega(2)).to.be.revertedWith(
        "Confirmar desde el eslabon inicial de la cadena"
      );
      // Los fondos siguen intactos
      expect(await escrow.fondosRetenidos()).to.equal(MONTO);
    });
  });

  describe("Liberación en cascada (2 eslabones)", function () {
    beforeEach(async function () {
      this.idE1 = await depositarRaiz();
      await escrow.crearEscrowEnCadena(
        vendedor.address,
        proveedor.address,
        usdt.target,
        HIJO,
        "Insumo",
        PLAZO,
        this.idE1
      );
    });

    it("A confirma -> C recibe 700 y B recibe 300 (telescopio)", async function () {
      await escrow.connect(comprador).confirmarEntrega(this.idE1);

      expect(await usdt.balanceOf(proveedor.address)).to.equal(HIJO); // 700
      expect(await usdt.balanceOf(vendedor.address)).to.equal(
        MONTO - HIJO // 300
      );
      expect(await escrow.fondosRetenidos()).to.equal(0);

      const e1 = await escrow.verTransaccion(this.idE1);
      const e2 = await escrow.verTransaccion(2);
      expect(e1.estado).to.equal(2); // COMPLETADO
      expect(e2.estado).to.equal(2);
    });
  });

  describe("Liberación en cascada (3 eslabones)", function () {
    it("A->B->C->D: suma de pagos = monto raíz", async function () {
      const idE1 = await depositarRaiz(); // A -> B, 1000
      await escrow.crearEscrowEnCadena(
        vendedor.address, // B compra...
        proveedor.address, // ...a C
        usdt.target,
        HIJO, // 700
        "Eslabon 2",
        PLAZO,
        idE1
      );
      await escrow.crearEscrowEnCadena(
        proveedor.address, // C compra...
        tercero.address, // ...a D
        usdt.target,
        NIETO, // 300
        "Eslabon 3",
        PLAZO,
        2
      );

      await escrow.connect(comprador).confirmarEntrega(idE1);

      // D recibe 300, C recibe 700-300=400, B recibe 1000-700=300
      expect(await usdt.balanceOf(tercero.address)).to.equal(NIETO);
      expect(await usdt.balanceOf(proveedor.address)).to.equal(
        HIJO - NIETO
      );
      expect(await usdt.balanceOf(vendedor.address)).to.equal(
        MONTO - HIJO
      );
      expect(await escrow.fondosRetenidos()).to.equal(0);
      expect(await usdt.balanceOf(comprador.address)).to.equal(
        toUnits(100000) - MONTO
      );
    });
  });

  describe("Disputas", function () {
    beforeEach(async function () {
      this.idE1 = await depositarRaiz();
      await escrow.crearEscrowEnCadena(
        vendedor.address,
        proveedor.address,
        usdt.target,
        HIJO,
        "Insumo",
        PLAZO,
        this.idE1
      );
    });

    it("abrir disputa en un hijo congela TODA la cadena", async function () {
      await escrow.connect(proveedor).abrirDisputa(2); // C (vendedor del hijo)
      expect((await escrow.verTransaccion(this.idE1)).estado).to.equal(3); // DISPUTA
      expect((await escrow.verTransaccion(2)).estado).to.equal(3);

      // Nadie puede confirmar mientras esté congelada
      await expect(
        escrow.connect(comprador).confirmarEntrega(this.idE1)
      ).to.be.revertedWith("Estado incorrecto para esta accion");
    });

    it("rechaza disputa de quien no es parte", async function () {
      await expect(escrow.connect(outsider).abrirDisputa(2)).to.be.revertedWith(
        "Solo comprador o vendedor"
      );
    });

    it("resolución a favor del vendedor libera la cadena completa", async function () {
      await escrow.connect(vendedor).abrirDisputa(this.idE1);
      await escrow.connect(plataforma).resolverDisputa(this.idE1, true);

      expect(await usdt.balanceOf(proveedor.address)).to.equal(HIJO);
      expect(await usdt.balanceOf(vendedor.address)).to.equal(MONTO - HIJO);
      expect(await escrow.fondosRetenidos()).to.equal(0);
    });

    it("resolución a favor del comprador reembolsa el monto raíz completo", async function () {
      const saldoAntes = await usdt.balanceOf(comprador.address);
      await escrow.connect(comprador).abrirDisputa(this.idE1);
      await escrow.connect(plataforma).resolverDisputa(this.idE1, false);

      expect(await usdt.balanceOf(comprador.address)).to.equal(saldoAntes + MONTO);
      expect(await escrow.fondosRetenidos()).to.equal(0);
      expect((await escrow.verTransaccion(this.idE1)).estado).to.equal(4); // REEMBOLSADO
      expect((await escrow.verTransaccion(2)).estado).to.equal(4);
      // El vendedor no recibió nada
      expect(await usdt.balanceOf(vendedor.address)).to.equal(0);
    });

    it("solo la plataforma (árbitro) puede resolver", async function () {
      await escrow.connect(vendedor).abrirDisputa(this.idE1);
      await expect(
        escrow.connect(outsider).resolverDisputa(this.idE1, true)
      ).to.be.revertedWith("Solo el arbitro puede resolver");
      await expect(
        escrow.connect(comprador).resolverDisputa(this.idE1, false)
      ).to.be.revertedWith("Solo el arbitro puede resolver");
    });

    it("no se puede resolver una disputa que no existe", async function () {
      await expect(
        escrow.connect(plataforma).resolverDisputa(this.idE1, true)
      ).to.be.revertedWith("Estado incorrecto para esta accion");
    });
  });

  describe("Expiración", function () {
    it("reembolso manual tras el plazo (cualquier parte del raíz)", async function () {
      const idE1 = await depositarRaiz();
      const saldoAntes = await usdt.balanceOf(comprador.address);

      // Antes del plazo: no se puede reclamar
      await expect(
        escrow.connect(comprador).reclamarVencido(idE1)
      ).to.be.revertedWith("Aun no vencio el plazo");

      await time.increase(PLAZO * 24 * 60 * 60 + 1);

      // El vendedor también puede dispararlo (el dinero vuelve al comprador)
      await expect(escrow.connect(vendedor).reclamarVencido(idE1))
        .to.emit(escrow, "Reembolsado")
        .withArgs(idE1, MONTO);

      expect(await usdt.balanceOf(comprador.address)).to.equal(saldoAntes + MONTO);
      expect(await escrow.fondosRetenidos()).to.equal(0);
    });

    it("el plazo que gobierna es el del raíz (reclamo desde un hijo)", async function () {
      const idE1 = await depositarRaiz();
      await escrow.crearEscrowEnCadena(
        vendedor.address,
        proveedor.address,
        usdt.target,
        HIJO,
        "Hijo",
        PLAZO,
        idE1
      );

      await time.increase(PLAZO * 24 * 60 * 60 + 1);

      // Reclamar usando el ID del hijo devuelve todo al comprador raíz
      const saldoAntes = await usdt.balanceOf(comprador.address);
      await escrow.connect(comprador).reclamarVencido(2);
      expect(await usdt.balanceOf(comprador.address)).to.equal(saldoAntes + MONTO);
      expect((await escrow.verTransaccion(idE1)).estado).to.equal(4);
      expect((await escrow.verTransaccion(2)).estado).to.equal(4);
    });

    it("un tercero no puede reclamar el reembolso", async function () {
      const idE1 = await depositarRaiz();
      await time.increase(PLAZO * 24 * 60 * 60 + 1);
      await expect(
        escrow.connect(outsider).reclamarVencido(idE1)
      ).to.be.revertedWith("Solo partes del eslabon raiz o el arbitro");
    });

    it("la plataforma cancela un escrow nunca pagado", async function () {
      const id = await crearRaiz();
      await escrow.connect(plataforma).cancelarPorExpiracion(id);
      expect((await escrow.verTransaccion(id)).estado).to.equal(5); // CANCELADO

      await expect(
        escrow.connect(outsider).cancelarPorExpiracion(id)
      ).to.be.revertedWith("Estado incorrecto para esta accion");
    });
  });

  describe("Consultas", function () {
    it("debería listar transacciones de un usuario", async function () {
      await escrow.crearEscrow(
        comprador.address,
        vendedor.address,
        usdt.target,
        MONTO,
        "T1",
        PLAZO
      );
      await escrow.crearEscrow(
        comprador.address,
        vendedor.address,
        usdt.target,
        MONTO,
        "T2",
        PLAZO
      );

      const txs = await escrow.verTransaccionesDe(vendedor.address);
      expect(txs.length).to.equal(2);
    });
  });
});
