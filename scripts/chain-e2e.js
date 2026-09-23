#!/usr/bin/env node
// End-to-end check of token payments against a real EVM: starts a local ganache
// chain (chain ID 4663, like Robinhood Chain), compiles and deploys an ERC-20
// with 18 decimals, then runs deposit -> job -> withdrawal through the real
// viem adapter in src/chain.js. Needs the dev dependencies (ganache, solc).
//
//   npm run test:chain
import assert from 'node:assert/strict';
import ganache from 'ganache';
import solc from 'solc';
import { createPublicClient, createWalletClient, http, defineChain, erc20Abi, parseUnits } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { createApp } from '../src/server.js';
import { createChain } from '../src/chain.js';

const SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract TestToken {
  string public name = "musebook"; string public symbol = "MUSEBOOK"; uint8 public decimals = 18;
  uint256 public totalSupply; mapping(address => uint256) public balanceOf; mapping(address => mapping(address => uint256)) public allowance;
  event Transfer(address indexed from, address indexed to, uint256 value);
  event Approval(address indexed owner, address indexed spender, uint256 value);
  constructor(uint256 supply) { totalSupply = supply; balanceOf[msg.sender] = supply; emit Transfer(address(0), msg.sender, supply); }
  function transfer(address to, uint256 value) external returns (bool) { return _move(msg.sender, to, value); }
  function approve(address s, uint256 v) external returns (bool) { allowance[msg.sender][s] = v; emit Approval(msg.sender, s, v); return true; }
  function transferFrom(address f, address t, uint256 v) external returns (bool) { allowance[f][msg.sender] -= v; return _move(f, t, v); }
  function _move(address f, address t, uint256 v) internal returns (bool) { balanceOf[f] -= v; balanceOf[t] += v; emit Transfer(f, t, v); return true; }
}`;

const log = (...a) => console.log('  ·', ...a);
const PORT = 8546;
const CHAIN_ID = 4663;
const keys = { hot: generatePrivateKey(), deployer: generatePrivateKey(), user: generatePrivateKey() };
const hot = privateKeyToAccount(keys.hot);
const deployer = privateKeyToAccount(keys.deployer);
const userWallet = privateKeyToAccount(keys.user);
const eth = (n) => `0x${(BigInt(n) * 10n ** 18n).toString(16)}`;

// every account gets 10 ETH for gas
const node = ganache.server({
  chain: { chainId: CHAIN_ID }, logging: { quiet: true },
  wallet: { accounts: Object.values(keys).map((secretKey) => ({ secretKey, balance: eth(10) })) },
});

async function main() {
  await new Promise((r, j) => node.listen(PORT, (e) => (e ? j(e) : r())));
  const rpcUrl = `http://127.0.0.1:${PORT}`;
  const chain = defineChain({ id: CHAIN_ID, name: 'local', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const pub = createPublicClient({ chain, transport: http(rpcUrl) });
  const mine = async (n) => { for (let i = 0; i < n; i++) await pub.request({ method: 'evm_mine', params: [] }); };

  log('compiling ERC-20 with solc', solc.version());
  const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'T.sol': { content: SOURCE } }, settings: { evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
  const errors = (out.errors || []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  const { abi, evm } = out.contracts['T.sol'].TestToken;

  const asDeployer = createWalletClient({ account: deployer, chain, transport: http(rpcUrl) });
  const asUser = createWalletClient({ account: userWallet, chain, transport: http(rpcUrl) });
  const hash = await asDeployer.deployContract({ abi, bytecode: `0x${evm.bytecode.object}`, args: [parseUnits('1000000', 18)] });
  const token = (await pub.waitForTransactionReceipt({ hash })).contractAddress;
  log('token deployed at', token);
  await pub.waitForTransactionReceipt({ hash: await asDeployer.writeContract({ address: token, abi: erc20Abi, functionName: 'transfer', args: [userWallet.address, parseUnits('50000', 18)] }) });
  // the treasury starts with a float so it can pay out more than one user deposited
  await pub.waitForTransactionReceipt({ hash: await asDeployer.writeContract({ address: token, abi: erc20Abi, functionName: 'transfer', args: [hot.address, parseUnits('1000', 18)] }) });

  process.env.ADMIN_TOKEN = 'e2e-admin';
  const cfg = { mode: 'token', rpcUrl, chainId: CHAIN_ID, chainName: 'local', token, symbol: 'MUSEBOOK', explorer: 'https://explorer.local', confirmations: 2, minWithdrawal: 100, fromBlock: null, privateKey: keys.hot };
  const app = createApp({ dbFile: ':memory:', sweepMs: 0, payments: { config: cfg, chain: createChain(cfg), pollMs: 0 } });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, path, { key, body } = {}) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
    return data;
  };
  try {
    assert.equal((await app.payments.poll()).ready, true, 'chain check passes (chain id, decimals, symbol)');
    const cfgOut = await call('GET', '/api/payments');
    assert.equal(cfgOut.decimals, 18);
    assert.equal(cfgOut.deposit_address, hot.address);
    log('payments ready; treasury is', hot.address);

    const poster = await call('POST', '/api/accounts', { body: { name: 'e2e-poster', kind: 'human' } });
    const solver = await call('POST', '/api/accounts', { body: { name: 'e2e-solver', kind: 'agent' } });
    const solverWallet = privateKeyToAccount(generatePrivateKey());
    for (const [acct, wallet] of [[poster, userWallet], [solver, solverWallet]]) {
      const ch = await call('GET', `/api/wallet/challenge?address=${wallet.address}`, { key: acct.api_key });
      await call('POST', '/api/wallet/link', { key: acct.api_key, body: { address: wallet.address, signature: await wallet.signMessage({ message: ch.message }) } });
    }
    log('both wallets linked with real personal_sign signatures');

    const dep = await asUser.writeContract({ address: token, abi: erc20Abi, functionName: 'transfer', args: [hot.address, parseUnits('20000', 18)] });
    await pub.waitForTransactionReceipt({ hash: dep });
    await app.payments.poll();
    assert.equal((await call('GET', '/api/me', { key: poster.api_key })).balance, 0, 'not yet confirmed');
    await mine(3);
    await app.payments.poll();
    assert.equal((await call('GET', '/api/me', { key: poster.api_key })).balance, 20000);
    log('deposit of 20,000 MUSEBOOK credited after confirmations');

    const i = await call('POST', '/api/intents', { key: poster.api_key, body: { title: 'On-chain paid job', body: 'Paid in MUSEBOOK from a real deposit.', budget: 12000 } });
    const bid = await call('POST', `/api/intents/${i.id}/bids`, { key: solver.api_key, body: { price: 10000, eta_hours: 1, pitch: 'Will do it right away.' } });
    await call('POST', `/api/intents/${i.id}/award`, { key: poster.api_key, body: { bid_id: bid.id } });
    await call('POST', `/api/intents/${i.id}/deliver`, { key: solver.api_key, body: { content: 'done' } });
    await call('POST', `/api/intents/${i.id}/accept`, { key: poster.api_key, body: { rating: 5 } });
    assert.equal((await call('GET', '/api/me', { key: solver.api_key })).balance, 9750);
    log('job settled: solver earned 9,750 after the 2.5% fee');

    const w = await call('POST', '/api/wallet/withdraw', { key: solver.api_key, body: { amount: 9000 } });
    const sent = await call('POST', `/api/admin/withdrawals/${w.id}/approve`, { key: 'e2e-admin' });
    assert.equal(sent.status, 'sending');
    const receipt = await pub.waitForTransactionReceipt({ hash: sent.tx_hash });
    assert.equal(receipt.status, 'success');
    log('admin approved; transfer mined in block', receipt.blockNumber);
    await mine(3);
    await app.payments.poll();
    const after = await call('GET', '/api/wallet', { key: solver.api_key });
    assert.equal(after.withdrawals[0].status, 'confirmed');
    const onchain = await pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [solverWallet.address] });
    assert.equal(onchain, parseUnits('9000', 18));
    log('solver wallet now holds 9,000 MUSEBOOK on-chain');

    const t = await call('GET', '/api/admin/treasury', { key: 'e2e-admin' });
    assert.equal(t.solvent, true);
    assert.equal(t.onchain_balance, 1000 + 20000 - 9000);
    assert.equal(t.owed_total, 20000 - 9000);
    assert.equal(app.market.ledgerTotal(), 0);
    log(`treasury: ${t.onchain_balance} on-chain vs ${t.owed_total} owed (surplus ${t.surplus} is the float) — solvent`);
    console.log('\nchain e2e: PASS');
  } finally {
    app.server.closeAllConnections(); app.server.close();
    await node.close();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
