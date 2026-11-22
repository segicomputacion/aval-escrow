const hre = require("hardhat");

async function main() {
  console.log("🚀 Desplegando AvalEscrow v2...\n");

  const [deployer] = await hre.ethers.getSigners();
  console.log(`📡 Desplegando desde: ${deployer.address}`);

  const balance = await deployer.provider.getBalance(deployer.address);
  console.log(`💰 Balance: ${hre.ethers.formatEther(balance)} MATIC\n`);

  const AvalEscrow = await hre.ethers.getContractFactory("AvalEscrow");
  const escrow = await AvalEscrow.deploy();

  await escrow.waitForDeployment();
  const address = await escrow.getAddress();
  console.log(`✅ AvalEscrow desplegado en: ${address}`);
  console.log(`🔗 Red: ${hre.network.name}`);
  console.log(`👤 Plataforma: ${deployer.address}\n`);

  if (hre.network.name !== "amoy" && hre.network.name !== "hardhat") {
    console.log("⏳ Verificando contrato en Polygonscan...");
    await hre.run("verify:verify", {
      address: address,
      constructorArguments: [],
    });
    console.log("✅ Contrato verificado!");
  }

  console.log(`\n🎉 Listo! Guardá esta dirección en el backend:`);
  console.log(`CONTRACT_ADDRESS=${address}`);
  console.log(`\n📋 El contrato es PLATFORMA-ONLY: solo la plataforma puede`);
  console.log(`   crear escrows y resolver disputas (árbitro = plataforma).`);
  console.log(`   Los fetch de la plataforma tienen queue; rotá PRIVATE_KEY.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
