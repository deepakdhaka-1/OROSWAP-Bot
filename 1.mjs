import fs from 'fs';
import dotenv from 'dotenv';
import chalk from 'chalk';
import { createInterface } from 'node:readline';
import { SigningCosmWasmClient } from '@cosmjs/cosmwasm-stargate';
import pkg from '@cosmjs/stargate';
const { GasPrice } = pkg;
import pkg2 from '@cosmjs/proto-signing';
const { DirectSecp256k1HdWallet } = pkg2;

dotenv.config();

// ========== PATCH: Undici headers timeout fix ==========
globalThis.fetch = (url, options = {}) => {
  options.headersTimeout = 30000; // 30s
  return import('undici').then(({ fetch }) => fetch(url, options));
};

// ========== Constants ==========
const RPC_URL = 'https://testnet-rpc.zigchain.com';
const EXPLORER_URL = 'https://zigscan.org/tx/';
const GAS_PRICE = GasPrice.fromString('0.026uzig');

const TOKEN_PAIRS = {
  ORO: {
    denom: 'coin.zig10rfjm85jmzfhravjwpq3hcdz8ngxg7lxd0drkr.uoro',
    contract: 'zig15jqg0hmp9n06q0as7uk3x9xkwr9k3r7yh4ww2uc0hek8zlryrgmsamk4qg'
  },
  NFA: {
    denom: 'coin.zig1qaf4dvjt5f8naam2mzpmysjm5e8sp2yhrzex8d.nfa',
    contract: 'zig1dye3zfsn83jmnxqdplkfmelyszhkve9ae6jfxf5mzgqnuylr0sdq8ng9tv'
  },
  CULTCOIN: {
    denom: 'coin.zig12jgpgq5ec88nwzkkjx7jyrzrljpph5pnags8sn.ucultcoin',
    contract: 'zig1j55nw46crxkm03fjdf3cqx3py5cd32jny685x9c3gftfdt2xlvjs63znce'
  },
  DYOR: {
    denom: 'coin.zig1fepzhtkq2r5gc4prq94yukg6vaqjvkam27gwk3.dyor',
    contract: 'zig1us8t6pklp2v2pjqnnedg9wnp3pv50kl448csv0lsuad599ef56jsyvakl9'
  },
  BEE: {
    denom: 'coin.zig1ptxpjgl3lsxrq99zl6ad2nmrx4lhnhne26m6ys.bee',
    contract: 'zig1r50m5lafnmctat4xpvwdpzqndynlxt2skhr4fhzh76u0qar2y9hqu74u5h'
  }
};

const rl = createInterface({ input: process.stdin, output: process.stdout });
const prompt = (q) => new Promise((res) => rl.question(chalk.cyanBright(q), res));

// ========== Utility ==========
function toMicro(amount) {
  return String(Math.floor(amount * 1e6));
}

async function getWallet(mnemonic) {
  return DirectSecp256k1HdWallet.fromMnemonic(mnemonic.trim(), { prefix: 'zig' });
}

async function getAddress(wallet) {
  const [acc] = await wallet.getAccounts();
  return acc.address;
}

async function retryWith429(fn, context, delayMs = 600_000) {
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const msg = err.message || '';
      if (msg.includes('429') || msg.includes('Headers Timeout') || msg.includes('UND_ERR_HEADERS_TIMEOUT')) {
        console.log(chalk.red(`ΓÜá∩╕Å Retry: ${context} ΓÇö ${msg}. Waiting 10 minute...`));
        await new Promise(r => setTimeout(r, delayMs));
      } else {
        throw err;
      }
    }
  }
}

async function safeClientConnect(context) {
  return await retryWith429(() => SigningCosmWasmClient.connect(RPC_URL), `${context} connect`);
}

async function safeSignerConnect(wallet, context) {
  return await retryWith429(() => SigningCosmWasmClient.connectWithSigner(RPC_URL, wallet, { gasPrice: GAS_PRICE }), `${context} signerConnect`);
}

async function getBalance(address, denom) {
  const client = await safeClientConnect("getBalance");
  const bal = await retryWith429(() => client.getBalance(address, denom), `getBalance ${denom}`);
  return parseFloat(bal.amount) / 1e6;
}

async function getPoolInfo(contractAddress) {
  try {
    const client = await safeClientConnect("getPoolInfo");
    return await retryWith429(() => client.queryContractSmart(contractAddress, { pool: {} }), `pool ${contractAddress}`);
  } catch (error) {
    console.warn(`[Pool] Failed to get pool info for ${contractAddress}: ${error.message}`);
    return null;
  }
}

async function performSwap(wallet, from, to, amount, pairName, index, total) {
  const address = await getAddress(wallet);
  const client = await safeSignerConnect(wallet, `swap ${pairName}`);
  const funds = [{ denom: from, amount: toMicro(amount) }];
  const msg = {
    swap: {
      offer_asset: {
        amount: funds[0].amount,
        info: { native_token: { denom: from } },
      },
      max_spread: "0.01",
    },
  };

  const contractAddr = TOKEN_PAIRS[pairName]?.contract;
  if (!contractAddr) return;

  const tx = await retryWith429(() => client.execute(address, contractAddr, msg, 'auto', '', funds), `swap ${pairName}`);
  console.log(`${chalk.yellow(`[${index}/${total}]`)} Swapped ${chalk.green(from)} ΓåÆ ${chalk.cyan(to)} (${chalk.magenta(amount.toFixed(6))}) | ${chalk.blue(EXPLORER_URL + tx.transactionHash)}`);
}

let liquidityTxCounter = 0;

async function addLiquidity(wallet, tokenDenom, zigDenom, pairName) {
  const address = await getAddress(wallet);
  const contractAddr = TOKEN_PAIRS[pairName].contract;
  const tokenAmt = await getBalance(address, tokenDenom);
  const zigAmt = await getBalance(address, zigDenom);
  if (tokenAmt <= 0 || zigAmt <= 0) return;

  const tokenAmtUsed = tokenAmt * 0.2;
  const zigAmtUsed = zigAmt * 0.2;
  const poolInfo = await getPoolInfo(contractAddr);
  if (!poolInfo || poolInfo.assets.length < 2) return;

  const poolToken1 = parseFloat(poolInfo.assets[0].amount) / 1e6;
  const poolZIG = parseFloat(poolInfo.assets[1].amount) / 1e6;
  const ratio = poolToken1 / poolZIG;

  let adjustedToken1 = tokenAmtUsed;
  let adjustedZIG = zigAmtUsed;

  if (tokenAmtUsed / zigAmtUsed > ratio) {
    adjustedToken1 = zigAmtUsed * ratio;
  } else {
    adjustedZIG = tokenAmtUsed / ratio;
  }

  const client = await safeSignerConnect(wallet, `${pairName} LP connectWithSigner`);
  const msg = {
    provide_liquidity: {
      assets: [
        { amount: toMicro(adjustedToken1), info: { native_token: { denom: tokenDenom } } },
        { amount: toMicro(adjustedZIG), info: { native_token: { denom: zigDenom } } }
      ],
      slippage_tolerance: "0.5",
    }
  };
  const funds = [
    { denom: tokenDenom, amount: toMicro(adjustedToken1) },
    { denom: zigDenom, amount: toMicro(adjustedZIG) }
  ];
  const tx = await retryWith429(() => client.execute(address, contractAddr, msg, 'auto', '', funds), `${pairName} LP on ${address}`);
  liquidityTxCounter++;
  console.log(`${chalk.green(`[${liquidityTxCounter}] LP`)} ${chalk.yellow(pairName)} + ZIG | Amount = ${adjustedToken1.toFixed(6)} ${chalk.blue(EXPLORER_URL + tx.transactionHash)}`);
}

async function processWallet(mnemonic, config, walletIndex, totalWallets) {
  const wallet = await getWallet(mnemonic);
  const address = await getAddress(wallet);
  console.log(`\n${chalk.bold.cyanBright(`Γëí Wallet ${walletIndex}/${totalWallets}`)} ${chalk.yellow(address)}`);

  const balances = { uzig: await getBalance(address, 'uzig') };
  for (const [symbol, data] of Object.entries(TOKEN_PAIRS)) {
    balances[data.denom] = await getBalance(address, data.denom);
  }

  console.log(chalk.magenta("\nΓëí Initial Balances:"));
  for (const [symbol, data] of Object.entries(TOKEN_PAIRS)) {
    console.log(`   ${chalk.green(symbol)}: ${chalk.yellow(balances[data.denom].toFixed(6))}`);
  }
  console.log(`   ${chalk.green('ZIG')}: ${chalk.yellow(balances.uzig.toFixed(6))}`);

  let swapCounter = 0;
  outer: for (let i = 0; i < config.swapCount; i++) {
    for (const [symbol, data] of Object.entries(TOKEN_PAIRS)) {
      if (swapCounter >= config.swapCount) break outer;
      const amt = Math.random() * (config.maxSwap - config.minSwap) + config.minSwap;
      const balance = await getBalance(address, 'uzig');
      if (amt > balance || amt < config.minSwap) continue;

      await performSwap(wallet, 'uzig', data.denom, amt, symbol, swapCounter + 1, config.swapCount);
      swapCounter++;
      await new Promise(r => setTimeout(r, config.delay * 1000));
    }
  }

  if (config.swapBack === 'yes') {
    console.log(chalk.blueBright("\nΓå⌐∩╕Å Swapping back 50% of each token to ZIG..."));
    for (const [symbol, data] of Object.entries(TOKEN_PAIRS)) {
      const balance = await getBalance(address, data.denom);
      if (balance > 0.0001) {
        const amtToSwap = balance * 0.5;
        await performSwap(wallet, data.denom, 'uzig', amtToSwap, symbol, 0, 0);
        await new Promise(r => setTimeout(r, config.delay * 1000));
      }
    }
  }

  const tokens = Object.entries(TOKEN_PAIRS);
  for (let i = 0; i < config.lpCount; i++) {
    const [symbol, data] = tokens[i % tokens.length];
    await addLiquidity(wallet, data.denom, 'uzig', symbol);
    await new Promise(r => setTimeout(r, config.delay * 1000));
  }
}

async function loopForDuration(durationMs, taskFn) {
  const start = Date.now();
  while (Date.now() - start < durationMs) {
    await taskFn();
    await new Promise(r => setTimeout(r, 10_000)); // Optional pause
  }
}

async function main() {
  console.clear();
  console.log(chalk.bgBlue.white.bold("\n     ≡ƒÜÇ OROSWAP - ZIGCHAIN TESTNET BOT ≡ƒÜÇ     \n"));

  const walletMnemonics = fs.readFileSync('wallet.txt', 'utf-8').split('\n').map(x => x.trim()).filter(Boolean);
  const minSwap = parseFloat(await prompt("Min ZIG Swap: "));
  const maxSwap = parseFloat(await prompt("Max ZIG Swap: "));
  const swapCount = parseInt(await prompt("Swap rounds (max total swaps): "));
  const lpCount = parseInt(await prompt("LP rounds: "));
  const delay = parseInt(await prompt("Delay (seconds): "));
  const swapBack = (await prompt("Do you want to swap back to ZIG after swaps? (yes/no): ")).toLowerCase();

  const config = { minSwap, maxSwap, swapCount, lpCount, delay, swapBack };

  await loopForDuration(10 * 60 * 1000, async () => {
    for (let i = 0; i < walletMnemonics.length; i++) {
      await processWallet(walletMnemonics[i], config, i + 1, walletMnemonics.length);
    }
  });

  rl.close();
}

main();
