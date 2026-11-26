#![no_std]
#![no_main]

use uapi::{CallFlags, HostFn, HostFnImpl as api, ReturnFlags, StorageFlags};

const XCM_PRECOMPILE: [u8; 20] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x0a, 0, 0,
];

const GRANT_SELECTOR: [u8; 4] = [0x91, 0x8e, 0x9d, 0xe3];
const PROGRAM_SELECTOR: [u8; 4] = [0x4b, 0x11, 0xfe, 0x54];
const EXECUTE_SELECTOR: [u8; 4] = [0xd3, 0xb7, 0xe0, 0x4d];
const WEIGH_MESSAGE_SELECTOR: [u8; 4] = [0x47, 0x40, 0x0c, 0x23];

const PEOPLE_PARA_ID: u32 = 1502;
const FEE_PLANCK: u128 = 10_000_000_000;

const PROXY_PALLET: u8 = 44;
const PROXY_PROXY_CALL: u8 = 0;
const SUDO_PALLET: u8 = 42;
const SUDO_SUDO_CALL: u8 = 0;
const NFT_CREDITS_PALLET: u8 = 57;
const NFT_CREDITS_GRANT_CALL: u8 = 103;

const FAUCET_GAME_BASE: u32 = 0x8000_0000;
const MAX_ROUNDS: u32 = 3;
const MAX_GROUP_SIZE: u32 = 6;
const SLOTS_PER_GAME: u32 = MAX_ROUNDS * MAX_GROUP_SIZE;
const ATTESTER_TAG: &[u8; 7] = b"dim2fct";

const XCM_VERSION_5: u8 = 5;
const WITHDRAW_ASSET: u8 = 0;
const TRANSACT: u8 = 6;
const DEPOSIT_ASSET: u8 = 13;
const REFUND_SURPLUS: u8 = 20;
const EXPECT_TRANSACT_STATUS: u8 = 32;
const SET_FEES_MODE: u8 = 43;
const ALIAS_ORIGIN: u8 = 46;
const INITIATE_TRANSFER: u8 = 49;

const PROGRAM_LEN: usize = 237;
const PROGRAM_WORDS: usize = PROGRAM_LEN.div_ceil(32);

struct Writer<const N: usize> {
    bytes: [u8; N],
    len: usize,
}

impl<const N: usize> Writer<N> {
    fn new() -> Self {
        Self {
            bytes: [0; N],
            len: 0,
        }
    }

    fn push(&mut self, bytes: &[u8]) {
        self.bytes[self.len..self.len + bytes.len()].copy_from_slice(bytes);
        self.len += bytes.len();
    }

    fn byte(&mut self, byte: u8) {
        self.push(&[byte]);
    }

    fn compact(&mut self, value: u128) {
        if value < 1 << 6 {
            self.byte((value as u8) << 2);
        } else if value < 1 << 14 {
            self.push(&(((value as u16) << 2) | 1).to_le_bytes());
        } else if value < 1 << 30 {
            self.push(&(((value as u32) << 2) | 2).to_le_bytes());
        } else {
            let bytes = value.to_le_bytes();
            let used = 16 - (value.leading_zeros() as usize / 8);
            self.byte((((used - 4) as u8) << 2) | 3);
            self.push(&bytes[..used]);
        }
    }

    fn word(&mut self, value: u64) {
        self.push(&[0; 24]);
        self.push(&value.to_be_bytes());
    }

    fn as_slice(&self) -> &[u8] {
        &self.bytes[..self.len]
    }
}

struct Slot {
    game_index: u32,
    round: u8,
    attester_position: u32,
}

impl Slot {
    fn attester(&self) -> [u8; 32] {
        let mut attester = [0u8; 32];
        attester[..ATTESTER_TAG.len()].copy_from_slice(ATTESTER_TAG);
        attester[8..12].copy_from_slice(&self.game_index.to_le_bytes());
        attester[12] = self.round;
        attester[13] = self.attester_position as u8;
        attester
    }

    fn nth(granted: u32) -> Self {
        let slot = granted % SLOTS_PER_GAME;
        Self {
            game_index: FAUCET_GAME_BASE + granted / SLOTS_PER_GAME,
            round: (slot / MAX_GROUP_SIZE) as u8,
            attester_position: slot % MAX_GROUP_SIZE,
        }
    }
}

fn pas<const N: usize>(out: &mut Writer<N>, amount: u128) {
    out.push(&[1, 0, 0]);
    out.compact(amount);
}

fn local_account<const N: usize>(out: &mut Writer<N>, id: &[u8; 32]) {
    out.push(&[0, 1, 1, 0]);
    out.push(id);
}

fn account_or_person<const N: usize>(out: &mut Writer<N>, account: &[u8; 32]) {
    out.byte(0);
    out.push(account);
}

fn grant_call(sudo_key: &[u8; 32], claimant: &[u8; 32], slot: &Slot) -> Writer<128> {
    let mut call = Writer::new();
    call.push(&[PROXY_PALLET, PROXY_PROXY_CALL]);
    call.byte(0);
    call.push(sudo_key);
    call.byte(0);
    call.push(&[SUDO_PALLET, SUDO_SUDO_CALL]);
    call.push(&[NFT_CREDITS_PALLET, NFT_CREDITS_GRANT_CALL]);
    account_or_person(&mut call, claimant);
    account_or_person(&mut call, &slot.attester());
    call.push(&slot.game_index.to_le_bytes());
    call.byte(slot.round);
    call.push(&slot.attester_position.to_le_bytes());
    call
}

fn grant_program(
    contract: &[u8; 32],
    sudo_key: &[u8; 32],
    claimant: &[u8; 32],
    slot: &Slot,
) -> Writer<PROGRAM_LEN> {
    let call = grant_call(sudo_key, claimant, slot);
    let mut program = Writer::new();
    program.byte(XCM_VERSION_5);
    program.compact(3);

    program.byte(WITHDRAW_ASSET);
    program.compact(1);
    pas(&mut program, FEE_PLANCK);

    program.push(&[SET_FEES_MODE, 1]);

    program.byte(INITIATE_TRANSFER);
    program.push(&[1, 1, 0]);
    program.compact(PEOPLE_PARA_ID.into());
    program.push(&[1, 0, 0]);
    program.compact(1);
    pas(&mut program, FEE_PLANCK);
    program.push(&[1, 0]);

    program.compact(5);
    program.byte(ALIAS_ORIGIN);
    local_account(&mut program, contract);
    program.push(&[TRANSACT, 1, 0]);
    program.compact(call.len as u128);
    program.push(call.as_slice());
    program.push(&[EXPECT_TRANSACT_STATUS, 0]);
    program.byte(REFUND_SURPLUS);
    program.push(&[DEPOSIT_ASSET, 1, 2]);
    program.compact(1);
    local_account(&mut program, contract);
    program
}

fn padded_bytes<const N: usize>(out: &mut Writer<N>, data: &[u8]) {
    out.word(data.len() as u64);
    out.push(data);
    out.push(&[0; 32][..(32 - data.len() % 32) % 32]);
}

fn call_xcm(input: &[u8], output: Option<&mut &mut [u8]>) {
    if api::call(
        CallFlags::empty(),
        &XCM_PRECOMPILE,
        u64::MAX,
        u64::MAX,
        &[u8::MAX; 32],
        &[0; 32],
        input,
        output,
    )
    .is_err()
    {
        api::return_value(ReturnFlags::REVERT, &[]);
    }
}

fn execute(program: &[u8]) {
    let mut weigh = Writer::<{ 4 + 64 + PROGRAM_WORDS * 32 }>::new();
    weigh.push(&WEIGH_MESSAGE_SELECTOR);
    weigh.word(32);
    padded_bytes(&mut weigh, program);
    let mut weight = [0u8; 64];
    call_xcm(weigh.as_slice(), Some(&mut &mut weight[..]));

    let mut run = Writer::<{ 4 + 128 + PROGRAM_WORDS * 32 }>::new();
    run.push(&EXECUTE_SELECTOR);
    run.word(96);
    run.push(&weight);
    padded_bytes(&mut run, program);
    call_xcm(run.as_slice(), None);
}

fn own_account() -> [u8; 32] {
    let mut address = [0u8; 20];
    api::address(&mut address);
    let mut account = [0xee; 32];
    account[..20].copy_from_slice(&address);
    account
}

fn sudo_key() -> [u8; 32] {
    let mut key = [0u8; 32];
    api::get_immutable_data(&mut &mut key[..]);
    key
}

fn granted(claimant: &[u8; 32]) -> u32 {
    let mut count = [0u8; 4];
    match api::get_storage(StorageFlags::empty(), claimant, &mut &mut count[..]) {
        Ok(()) => u32::from_le_bytes(count),
        Err(_) => 0,
    }
}

fn require_input(len: usize) {
    if api::call_data_size() != len as u64 {
        api::return_value(ReturnFlags::REVERT, &[]);
    }
}

#[no_mangle]
#[polkavm_derive::polkavm_export]
pub extern "C" fn deploy() {
    let mut key = [0u8; 32];
    require_input(key.len());
    api::call_data_copy(&mut key, 0);
    api::set_immutable_data(&key);
}

#[no_mangle]
#[polkavm_derive::polkavm_export]
pub extern "C" fn call() {
    let mut input = [0u8; 36];
    require_input(input.len());
    api::call_data_copy(&mut input, 0);
    let selector: [u8; 4] = input[..4].try_into().unwrap();
    let claimant: [u8; 32] = input[4..].try_into().unwrap();

    let count = granted(&claimant);
    let program = grant_program(&own_account(), &sudo_key(), &claimant, &Slot::nth(count));

    match selector {
        GRANT_SELECTOR => {
            execute(program.as_slice());
            api::set_storage(StorageFlags::empty(), &claimant, &(count + 1).to_le_bytes());
            api::return_value(ReturnFlags::empty(), &[]);
        }
        PROGRAM_SELECTOR => {
            let mut out = Writer::<{ 32 + 32 + PROGRAM_WORDS * 32 }>::new();
            out.word(32);
            padded_bytes(&mut out, program.as_slice());
            api::return_value(ReturnFlags::empty(), out.as_slice());
        }
        _ => api::return_value(ReturnFlags::REVERT, &[]),
    }
}

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    // SAFETY: `unimp` always traps, so control never returns.
    unsafe {
        core::arch::asm!("unimp");
        core::hint::unreachable_unchecked();
    }
}
