/**
 * The network the faucet runs on, the PCF devnet: the contract and the names on Paseo Asset Hub,
 * storage on Bulletin (para 1010). The DotNS registry, the IPFS gateway and the Bulletin endpoints
 * are the `devnet` environment of @polkadot-community-foundation/polkadot-app-deploy 0.16.7, the
 * tool deploy-app.yml publishes with.
 */
export const DEVNET = {
  assetHub: ['wss://asset-hub-paseo-rpc.n.dwellir.com', 'wss://sys.turboflakes.io/asset-hub-paseo'],
  assetHubGenesis: '0xd6eec26135305a8ad257a20d003357284c8aa03d0bdb2b357ab0a22371e11ef2',
  /** Paseo Asset Hub's Ethereum RPC, for DotNS reads. */
  ethRpc: 'https://eth-rpc-testnet.polkadot.io',
  dotnsRegistry: '0xb052E5EfC5ADEff1f21d48DEfb5169Cb394A1a73',
  ipfsGateway: 'https://devnet-ipfs.api.polkadotcommunity.foundation',
  bulletin: ['wss://bulletin-paseo.tservices.es:8443', 'wss://bullet.sik.rocks'],
  bulletinGenesis: '0xe101f0fa4627d29a257645e02be86d80378fea1a2bf8fa6a918d150ebc760a59',
} as const;
