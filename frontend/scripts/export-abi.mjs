import { readFileSync, writeFileSync } from 'node:fs';
const artifact = JSON.parse(readFileSync(new URL('../../contracts/out/PaseoFaucet.sol/PaseoFaucet.json', import.meta.url), 'utf8'));
writeFileSync(new URL('../src/faucet.abi.json', import.meta.url), JSON.stringify(artifact.abi, null, 2) + '\n');
console.log('Exported ABI from Ale’s contracts/src/PaseoFaucet.sol');
