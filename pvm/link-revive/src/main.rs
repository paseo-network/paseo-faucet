use polkavm_linker::{program_from_elf, Config, TargetInstructionSet};

fn main() {
    let [_, elf, blob]: [String; 3] = std::env::args()
        .collect::<Vec<_>>()
        .try_into()
        .expect("usage: link-revive <elf> <blob>");
    let mut config = Config::default();
    config.set_strip(true).set_optimize(true);
    let code = std::fs::read(&elf).expect("read the ELF");
    let program =
        program_from_elf(config, TargetInstructionSet::ReviveV1, &code).expect("link the ELF");
    std::fs::write(&blob, program).expect("write the blob");
}
