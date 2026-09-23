// The only module that talks to the blockchain. It wraps viem behind a small
// interface so the payments logic can be tested against an in-memory fake.
//
//   check()                      -> { chainId, decimals, symbol }   (throws on a wrong chain)
//   head()                       -> bigint latest block number
//   transfersTo(from, to)        -> [{ txHash, logIndex, blockNumber, from, to, value }]
//   signTransfer(to, rawAmount)  -> { hash, raw, nonce }             (signed, not sent)
//   broadcast(raw)               -> hash
//   receipt(hash)                -> null | { status: 'success' | 'reverted', blockNumber }
//   txExists(hash)               -> boolean
//   confirmedNonce()             -> number of transactions the hot wallet has mined
//   tokenBalance(address) / nativeBalance(address) -> bigint
//   verify(address, message, signature) -> boolean   (EOA personal_sign)
import {
  createPublicClient, http, defineChain, erc20Abi, parseAbiItem, encodeFunctionData,
  keccak256, getAddress, verifyMessage,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

export function createChain({ rpcUrl, chainId, token, privateKey, depositAddress }) {
  const chain = defineChain({
    id: chainId, name: `chain-${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  // cacheTime 0: viem otherwise reuses the last block number for a few seconds
  const client = createPublicClient({ chain, cacheTime: 0, transport: http(rpcUrl, { timeout: 20_000, retryCount: 2 }) });
  const account = privateKey ? privateKeyToAccount(privateKey) : null;
  const treasury = account ? account.address : getAddress(depositAddress);
  const tokenAddress = getAddress(token);

  return {
    treasury,
    token: tokenAddress,
    canSend: Boolean(account),

    async check() {
      const id = await client.getChainId();
      if (id !== chainId) throw new Error(`RPC is on chain ${id}, expected ${chainId}`);
      const [decimals, symbol] = await Promise.all([
        client.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'decimals' }),
        client.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'symbol' }),
      ]);
      return { chainId: id, decimals: Number(decimals), symbol };
    },

    head: () => client.getBlockNumber(),

    async transfersTo(fromBlock, toBlock) {
      const logs = await client.getLogs({ address: tokenAddress, event: TRANSFER, args: { to: treasury }, fromBlock, toBlock });
      return logs.map((l) => ({
        txHash: l.transactionHash, logIndex: l.logIndex, blockNumber: l.blockNumber,
        from: getAddress(l.args.from), to: getAddress(l.args.to), value: l.args.value,
      }));
    },

    async signTransfer(to, rawAmount) {
      if (!account) throw new Error('no hot wallet key configured');
      const nonce = await client.getTransactionCount({ address: account.address, blockTag: 'pending' });
      const request = await client.prepareTransactionRequest({
        account, chain, nonce, to: tokenAddress,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [getAddress(to), rawAmount] }),
      });
      const raw = await account.signTransaction(request);
      return { hash: keccak256(raw), raw, nonce };
    },

    broadcast: (raw) => client.sendRawTransaction({ serializedTransaction: raw }),

    async receipt(hash) {
      try {
        const r = await client.getTransactionReceipt({ hash });
        return { status: r.status, blockNumber: r.blockNumber };
      } catch (err) {
        if (err.name === 'TransactionReceiptNotFoundError') return null;
        throw err;
      }
    },

    async txExists(hash) {
      try { await client.getTransaction({ hash }); return true; } catch (err) {
        if (err.name === 'TransactionNotFoundError') return false;
        throw err;
      }
    },

    confirmedNonce: () => client.getTransactionCount({ address: treasury, blockTag: 'latest' }),
    tokenBalance: (address) => client.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'balanceOf', args: [getAddress(address)] }),
    nativeBalance: (address) => client.getBalance({ address: getAddress(address) }),
    verify: (address, message, signature) => verifyMessage({ address: getAddress(address), message, signature }),
  };
}
