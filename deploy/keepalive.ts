import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Bulletin, signerFromMnemonic, signerFromUri } from './bulletin.ts';
import { authorizationUpkeep, decodeCar, encodeCar, gatewayFetcher, plan, resolveRoot, walk, type Block } from './lib.ts';
import { DEVNET } from './network.ts';

const USAGE = `Keeps the app published under a DotNS name stored on Bulletin.

  tsx keepalive.ts archive --name <name> --car <file>
      Fetch every block the name points at, check each against its CID and against Bulletin,
      and write them to a CAR.
  tsx keepalive.ts status --name <name> --car <file> [--min-age-days <days>]
      Report when Bulletin last stored the archived blocks and whether a pass is due.
  tsx keepalive.ts restore --name <name> --car <file> [--min-age-days <days>] [--force]
      Store every archived block again when one is missing or the oldest store is --min-age-days
      old (13 by default; Bulletin keeps data for 14 days). Signs with MNEMONIC, the account the
      deploy stored with.
  tsx keepalive.ts authorize [--account <address>] [--min-days <days>]
      Make sure the account may store on Bulletin for --min-days more (3 by default): grant it an
      authorization when it has none or its grant has expired, extend the grant when it ends
      sooner. Signs with BULLETIN_AUTHORIZER, the key URI of a Bulletin storage authorizer. The
      account is MNEMONIC's unless --account is given.

  --bulletin <url,...>  Bulletin endpoints, instead of the PCF devnet's.`;

const DAY_MS = 86_400_000;

/** What a new authorization allows. Bulletin does not refuse a store beyond it while the authorization lasts. */
const GRANT = { transactions: 1_000, bytes: 1n << 30n };

function report(lines: string[]): void {
  const text = `${lines.join('\n')}\n`;
  process.stdout.write(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

const totalBytes = (blocks: Block[]) => blocks.reduce((sum, block) => sum + block.bytes.length, 0);

function mnemonicAccount() {
  const mnemonic = process.env.MNEMONIC;
  if (!mnemonic) throw new Error('MNEMONIC is not set');
  return signerFromMnemonic(mnemonic);
}

/** A connection to the PCF devnet's Bulletin through `endpoints`, which may be a fork of it. */
async function connect(endpoints: readonly string[]): Promise<Bulletin> {
  const bulletin = Bulletin.connect(endpoints);
  try {
    const genesis = await bulletin.genesis();
    if (genesis !== DEVNET.bulletinGenesis) throw new Error(`${endpoints[0]} is not the PCF devnet's Bulletin (genesis ${genesis})`);
    return bulletin;
  } catch (error) {
    bulletin.destroy();
    throw error;
  }
}

async function assess(bulletin: Bulletin, blocks: Block[], minAgeDays: number) {
  const [head, retention] = await Promise.all([bulletin.head(), bulletin.retention()]);
  const blockMs = await bulletin.blockTimeMs(head);
  const minAgeBlocks = Math.round((minAgeDays * DAY_MS) / blockMs);
  if (minAgeBlocks >= retention) {
    throw new Error(`--min-age-days ${minAgeDays} is not shorter than Bulletin's retention of ${retention} blocks`);
  }
  const storedAt = await bulletin.storedAt(blocks);
  const days = (count: number) => ((count * blockMs) / DAY_MS).toFixed(1);
  const state = plan(storedAt, head, retention, minAgeBlocks);
  const rows = [
    `| Blocks | ${blocks.length}, ${totalBytes(blocks)} bytes |`,
    `| Missing on Bulletin | ${state.missing} |`,
    state.oldestStoredAt === undefined
      ? '| Oldest store | none |'
      : `| Oldest store | block ${state.oldestStoredAt}, ${days(head - state.oldestStoredAt)} days ago; expires in ${days(state.blocksLeft ?? 0)} days |`,
    `| Due | ${state.due ? 'yes' : `no, at ${minAgeDays} days`} |`,
  ];
  return { head, storedAt, state, rows };
}

async function archive(name: string, carPath: string, endpoints: readonly string[]): Promise<void> {
  const root = await resolveRoot(name, DEVNET.ethRpc, DEVNET.dotnsRegistry);
  const blocks = await walk(root, gatewayFetcher(DEVNET.ipfsGateway));
  const bulletin = await connect(endpoints);
  try {
    const storedAt = await bulletin.storedAt(blocks);
    const missing = blocks.filter((_, i) => storedAt[i] === undefined);
    if (missing.length) throw new Error(`Bulletin does not hold ${missing.length} of ${blocks.length} blocks, ${missing[0].cid} first`);
    writeFileSync(carPath, await encodeCar(root, blocks));
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `root=${root}\n`);
    report([`### Archived ${name}`, '', '| | |', '|---|---|', `| Root | \`${root}\` |`, `| Blocks | ${blocks.length}, ${totalBytes(blocks)} bytes |`]);
  } finally {
    bulletin.destroy();
  }
}

async function check(
  name: string,
  carPath: string,
  endpoints: readonly string[],
  minAgeDays: number,
  restore: boolean,
  force: boolean,
): Promise<void> {
  const { root, blocks } = await decodeCar(readFileSync(carPath));
  const pointed = await resolveRoot(name, DEVNET.ethRpc, DEVNET.dotnsRegistry);
  if (!pointed.equals(root)) {
    throw new Error(`${name} points at ${pointed}, but the archive holds ${root}: deploy the app again to archive what the name points at`);
  }
  const bulletin = await connect(endpoints);
  try {
    const before = await assess(bulletin, blocks, minAgeDays);
    report([`### ${name}`, '', '| | |', '|---|---|', `| Root | \`${root}\` |`, ...before.rows]);
    if (!restore || (!before.state.due && !force)) return;

    const { signer, address } = mnemonicAccount();
    const authorization = await bulletin.authorization(address);
    if (!authorization || authorization.expiration <= before.head) {
      throw new Error(`${address} has no unexpired Bulletin storage authorization: run authorize first`);
    }
    if (
      authorization.transactions + blocks.length > authorization.transactionsAllowance ||
      authorization.bytes + BigInt(totalBytes(blocks)) > authorization.bytesAllowance
    ) {
      console.log(`::warning::${address} stores beyond its authorization allowance; Bulletin accepts it while the authorization is unexpired`);
    }

    for (const block of [...blocks].reverse()) {
      await bulletin.store(block, signer);
      console.log(`stored ${block.cid} (${block.bytes.length} bytes)`);
    }
    const storedAt = await bulletin.storedAt(blocks);
    const stale = blocks.filter((_, i) => (storedAt[i] ?? 0) <= before.head);
    if (stale.length) throw new Error(`${stale.length} blocks were not stored again, ${stale[0].cid} first`);
    const after = await assess(bulletin, blocks, minAgeDays);
    report([`Stored ${blocks.length} blocks again with ${address}.`, '', '| | |', '|---|---|', ...after.rows]);
  } finally {
    bulletin.destroy();
  }
}

async function authorize(account: string | undefined, endpoints: readonly string[], minDays: number): Promise<void> {
  const uri = process.env.BULLETIN_AUTHORIZER;
  if (!uri) throw new Error('BULLETIN_AUTHORIZER is not set');
  const authorizer = signerFromUri(uri);
  const who = account ?? mnemonicAccount().address;
  const bulletin = await connect(endpoints);
  try {
    if (!(await bulletin.isAuthorizer(authorizer.address))) throw new Error(`${authorizer.address} is not a Bulletin storage authorizer`);
    const [head, period] = await Promise.all([bulletin.head(), bulletin.authorizationPeriod()]);
    const blockMs = await bulletin.blockTimeMs(head);
    const minBlocks = Math.round((minDays * DAY_MS) / blockMs);
    if (minBlocks >= period) {
      throw new Error(`--min-days ${minDays} is not shorter than Bulletin's authorization period of ${period} blocks`);
    }
    const action = authorizationUpkeep((await bulletin.authorization(who))?.expiration, head, minBlocks);
    if (action === 'grant') await bulletin.authorize(who, GRANT.transactions, GRANT.bytes, authorizer.signer);
    if (action === 'extend') await bulletin.refresh(who, authorizer.signer);

    const [now, after] = await Promise.all([bulletin.head(), bulletin.authorization(who)]);
    if (!after || after.expiration - now < minBlocks) {
      throw new Error(`${who}'s authorization ends at block ${after?.expiration ?? 'none'}, sooner than ${minDays} days`);
    }
    const days = (((after.expiration - now) * blockMs) / DAY_MS).toFixed(1);
    report([
      `### Bulletin storage authorization of ${who}`,
      '',
      '| | |',
      '|---|---|',
      `| Action | ${{ grant: `granted by ${authorizer.address}`, extend: `extended by ${authorizer.address}`, none: 'none needed' }[action]} |`,
      `| Ends | block ${after.expiration}, in ${days} days |`,
      `| Used | ${after.transactions} of ${after.transactionsAllowance} transactions, ${after.bytes} of ${after.bytesAllowance} bytes |`,
    ]);
  } finally {
    bulletin.destroy();
  }
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: 'string' },
    car: { type: 'string' },
    'min-age-days': { type: 'string', default: '13' },
    force: { type: 'boolean', default: false },
    account: { type: 'string' },
    'min-days': { type: 'string', default: '3' },
    bulletin: { type: 'string' },
  },
});
const [command] = positionals;
const minAgeDays = Number(values['min-age-days']);
const minDays = Number(values['min-days']);
const endpoints = values.bulletin ? values.bulletin.split(',') : DEVNET.bulletin;
const valid =
  command === 'authorize'
    ? minDays > 0
    : ['archive', 'status', 'restore'].includes(command) && Boolean(values.name && values.car) && minAgeDays > 0;
if (!valid) {
  console.error(USAGE);
  process.exit(2);
}
try {
  if (command === 'authorize') await authorize(values.account, endpoints, minDays);
  else if (command === 'archive') await archive(values.name!, values.car!, endpoints);
  else await check(values.name!, values.car!, endpoints, minAgeDays, command === 'restore', values.force);
  process.exit(0);
} catch (error) {
  console.error(`::error::${(error as Error).message}`);
  process.exit(1);
}
