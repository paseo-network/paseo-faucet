# Paseo personhood faucet

Specification and architecture for a Paseo faucet without a custodial backend. A contract on
Paseo Asset Hub drips PAS and pUSD (the Paseo counterpart of dotUSD) once per person per
epoch, gated by proof of personhood, to Asset Hub or by XCM to other chains (People, Coretime
and Bridge Hub at launch; the owner adds or removes destinations with a contract call). A
DotNS product, running inside the Polkadot hosts, is the front-end people claim through.

**Status:** specification draft for review. There is no implementation in this repository yet.

## Documents

| Document | Read it for |
|---|---|
| [docs/SPEC.md](docs/SPEC.md) | requirements, soft requirements, architecture, flows, contract and product behaviour, risks, open decisions, readiness checklist |
| [docs/BACKGROUND.md](docs/BACKGROUND.md) | the faucet today, how proof of personhood and People Lite work on Paseo, the `IPersonhood` precompile, how products get proofs, pUSD, contract mechanics on Paseo AH |
| [docs/REFERENCES.md](docs/REFERENCES.md) | every source pinned to a commit, the live evidence, computed test vectors |
| [docs/evidence/live-facts.json](docs/evidence/live-facts.json) | read-only snapshot of the Paseo and Polkadot chain state the spec cites |

## Reviewing

Every factual claim carries an id (`[R6]`, `[P13]`, `[E1]`, …) that resolves to a pinned
source line or a live read in [REFERENCES.md](docs/REFERENCES.md). Decisions that are open are
listed as `D-nn` in [SPEC.md §16](docs/SPEC.md#16-open-decisions), and the experiments that must
pass before implementation starts are `SP-nn` in [SPEC.md §17](docs/SPEC.md#17-readiness-checklist).
