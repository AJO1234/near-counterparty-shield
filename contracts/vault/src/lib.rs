//! Shield Vault: the on-chain half of the Counterparty Shield.
//!
//! The AI agent never holds a key that can move money directly. Its account holds
//! only a function-call key limited to this contract's `pay` method, and `pay` only
//! succeeds when:
//!   1. the caller is the configured agent account,
//!   2. the payment carries a ticket signed by the Shield (an ALLOW verdict for
//!      exactly this receiver, amount and nonce, not yet expired),
//!   3. the payment fits the per-payment cap and the daily cap, and
//!   4. the vault is not paused.
//!
//! So even an agent that has been fully taken over (prompt injection, a malicious
//! tool) and calls the contract directly, skipping the off-chain wrapper, cannot
//! pay a receiver the Shield refused, and cannot spend more than the daily cap.
//!
//! The human owner keeps a full-access key and is the only one who can change
//! limits, withdraw, or approve a WARN payment (`owner_pay` needs 1 yoctoNEAR
//! attached, which a function-call key cannot do).

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, AccountId, NearToken, PanicOnDefault, Promise};

// ---------------------------------------------------------------- error reporting
// near-sys 0.4 declares the host's `panic_utf8` as `extern "C-unwind" fn(..) -> !`.
// Built with rustc 1.99, that import is dropped from the wasm entirely, so every
// `require!`/`panic_str` became a bare "unreachable" trap with no message on-chain.
// We declare the same host function ourselves, without `-> !`, and use it for
// every error, so callers see e.g. "Smart contract panicked: shield ticket expired".
#[cfg(target_arch = "wasm32")]
mod host {
    #[link(wasm_import_module = "env")]
    extern "C" {
        #[link_name = "panic_utf8"]
        pub fn panic_utf8(len: u64, ptr: u64);
    }
}

pub fn fail(msg: &str) -> ! {
    #[cfg(target_arch = "wasm32")]
    unsafe {
        host::panic_utf8(msg.len() as u64, msg.as_ptr() as u64);
        core::arch::wasm32::unreachable()
    }
    #[cfg(not(target_arch = "wasm32"))]
    panic!("{}", msg)
}

macro_rules! require {
    ($cond:expr, $msg:expr $(,)?) => {
        if !$cond {
            crate::fail($msg)
        }
    };
}

const MS_PER_DAY: u64 = 86_400_000;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    owner: AccountId,
    agent: AccountId,
    shield_public_key: Vec<u8>,
    max_per_payment: u128,
    daily_limit: u128,
    day: u64,
    spent_today: u128,
    paused: bool,
    used_nonces: LookupMap<String, bool>,
}

#[near(serializers = [json])]
pub struct VaultConfig {
    pub owner: AccountId,
    pub agent: AccountId,
    pub shield_public_key_hex: String,
    pub max_per_payment: U128,
    pub daily_limit: U128,
    pub spent_today: U128,
    pub paused: bool,
}

fn hex_decode(s: &str) -> Vec<u8> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    require!(s.len() % 2 == 0, "hex string has odd length");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap_or_else(|_| crate::fail("invalid hex")))
        .collect()
}

fn hex_encode(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

#[near]
impl Vault {
    #[init]
    pub fn new(
        owner: AccountId,
        agent: AccountId,
        shield_public_key_hex: String,
        max_per_payment: U128,
        daily_limit: U128,
    ) -> Self {
        let pk = hex_decode(&shield_public_key_hex);
        require!(pk.len() == 32, "shield public key must be 32 bytes (ed25519)");
        Self {
            owner,
            agent,
            shield_public_key: pk,
            max_per_payment: max_per_payment.0,
            daily_limit: daily_limit.0,
            day: env::block_timestamp_ms() / MS_PER_DAY,
            spent_today: 0,
            paused: false,
            used_nonces: LookupMap::new(b"n"),
        }
    }

    /// The exact bytes the Shield signs. The Node side builds the same string.
    pub fn ticket_message(&self, receiver: AccountId, amount: U128, nonce: String, expires_at_ms: u64) -> String {
        format!("shield-ticket:v1|{}|{}|{}|{}|{}", env::current_account_id(), receiver, amount.0, nonce, expires_at_ms)
    }

    /// Called by the agent (function-call key, no deposit).
    pub fn pay(&mut self, receiver: AccountId, amount: U128, nonce: String, expires_at_ms: u64, signature_hex: String) -> Promise {
        require!(env::predecessor_account_id() == self.agent, "only the agent account can call pay");
        require!(!self.paused, "vault is paused");
        require!(env::block_timestamp_ms() <= expires_at_ms, "shield ticket expired");
        require!(nonce.len() >= 8 && nonce.len() <= 64, "bad nonce");

        let sig = hex_decode(&signature_hex);
        require!(sig.len() == 64, "signature must be 64 bytes");
        let msg = self.ticket_message(receiver.clone(), amount, nonce.clone(), expires_at_ms);
        let sig: [u8; 64] = sig.try_into().unwrap();
        let pk: [u8; 32] = self.shield_public_key.clone().try_into().unwrap();
        require!(env::ed25519_verify(&sig, msg.as_bytes(), &pk), "shield ticket signature is invalid");
        require!(!self.used_nonces.contains_key(&nonce), "shield ticket already used");

        self.spend(amount.0);
        self.used_nonces.insert(nonce.clone(), true);
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"shield-vault\",\"version\":\"1.0.0\",\"event\":\"pay\",\"data\":{{\"receiver\":\"{}\",\"amount\":\"{}\",\"nonce\":\"{}\"}}}}",
            receiver, amount.0, nonce
        ));
        Promise::new(receiver).transfer(NearToken::from_yoctonear(amount.0))
    }

    /// The human approves a payment the Shield flagged WARN. Requires the owner's
    /// full-access key (1 yoctoNEAR attached), so the agent cannot call it.
    /// Still counts against the daily cap.
    #[payable]
    pub fn owner_pay(&mut self, receiver: AccountId, amount: U128) -> Promise {
        self.assert_owner();
        self.spend(amount.0);
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"shield-vault\",\"version\":\"1.0.0\",\"event\":\"owner_pay\",\"data\":{{\"receiver\":\"{}\",\"amount\":\"{}\"}}}}",
            receiver, amount.0
        ));
        Promise::new(receiver).transfer(NearToken::from_yoctonear(amount.0))
    }

    // ------------------------------------------------------------ owner admin

    #[payable]
    pub fn set_limits(&mut self, max_per_payment: U128, daily_limit: U128) {
        self.assert_owner();
        self.max_per_payment = max_per_payment.0;
        self.daily_limit = daily_limit.0;
    }

    #[payable]
    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
    }

    #[payable]
    pub fn set_agent(&mut self, agent: AccountId) {
        self.assert_owner();
        self.agent = agent;
    }

    #[payable]
    pub fn set_shield_key(&mut self, shield_public_key_hex: String) {
        self.assert_owner();
        let pk = hex_decode(&shield_public_key_hex);
        require!(pk.len() == 32, "shield public key must be 32 bytes");
        self.shield_public_key = pk;
    }

    #[payable]
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        self.assert_owner();
        Promise::new(self.owner.clone()).transfer(NearToken::from_yoctonear(amount.0))
    }

    // ------------------------------------------------------------ views

    pub fn get_config(&self) -> VaultConfig {
        let today = env::block_timestamp_ms() / MS_PER_DAY;
        VaultConfig {
            owner: self.owner.clone(),
            agent: self.agent.clone(),
            shield_public_key_hex: hex_encode(&self.shield_public_key),
            max_per_payment: U128(self.max_per_payment),
            daily_limit: U128(self.daily_limit),
            spent_today: U128(if today == self.day { self.spent_today } else { 0 }),
            paused: self.paused,
        }
    }

    // ------------------------------------------------------------ internal

    fn assert_owner(&self) {
        require!(env::attached_deposit() == NearToken::from_yoctonear(1), "attach exactly 1 yoctoNEAR (full-access key required)");
        require!(env::predecessor_account_id() == self.owner, "only the owner");
    }

    fn spend(&mut self, amount: u128) {
        require!(amount > 0, "amount must be positive");
        require!(amount <= self.max_per_payment, "amount exceeds the per-payment cap");
        let today = env::block_timestamp_ms() / MS_PER_DAY;
        if today != self.day {
            self.day = today;
            self.spent_today = 0;
        }
        let after = self.spent_today.checked_add(amount).unwrap_or_else(|| crate::fail("overflow"));
        require!(after <= self.daily_limit, "daily spending cap reached");
        self.spent_today = after;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;

    fn ctx(predecessor: &str, deposit: u128, now_ms: u64) {
        let mut b = VMContextBuilder::new();
        b.current_account_id("vault.testnet".parse().unwrap())
            .predecessor_account_id(predecessor.parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .account_balance(NearToken::from_near(100))
            .block_timestamp(now_ms * 1_000_000);
        testing_env!(b.build());
    }

    fn vault() -> Vault {
        ctx("owner.testnet", 0, 1_000);
        Vault::new(
            "owner.testnet".parse().unwrap(),
            "agent.testnet".parse().unwrap(),
            "00".repeat(32),
            U128(2 * ONE_NEAR),
            U128(3 * ONE_NEAR),
        )
    }

    #[test]
    #[should_panic(expected = "only the agent account can call pay")]
    fn stranger_cannot_pay() {
        let mut v = vault();
        ctx("mallory.testnet", 0, 1_000);
        v.pay("x.testnet".parse().unwrap(), U128(ONE_NEAR), "nonce-123456".into(), 9_999, "00".repeat(64));
    }

    #[test]
    #[should_panic(expected = "shield ticket signature is invalid")]
    fn forged_ticket_is_rejected() {
        let mut v = vault();
        ctx("agent.testnet", 0, 1_000);
        v.pay("x.testnet".parse().unwrap(), U128(ONE_NEAR), "nonce-123456".into(), 9_999, "00".repeat(64));
    }

    #[test]
    #[should_panic(expected = "shield ticket expired")]
    fn expired_ticket_is_rejected() {
        let mut v = vault();
        ctx("agent.testnet", 0, 10_000);
        v.pay("x.testnet".parse().unwrap(), U128(ONE_NEAR), "nonce-123456".into(), 9_999, "00".repeat(64));
    }

    #[test]
    #[should_panic(expected = "attach exactly 1 yoctoNEAR")]
    fn agent_key_cannot_use_owner_pay() {
        let mut v = vault();
        ctx("owner.testnet", 0, 1_000);
        v.owner_pay("x.testnet".parse().unwrap(), U128(ONE_NEAR));
    }

    #[test]
    #[should_panic(expected = "daily spending cap reached")]
    fn daily_cap_holds_even_for_owner() {
        let mut v = vault();
        ctx("owner.testnet", 1, 1_000);
        v.owner_pay("x.testnet".parse().unwrap(), U128(2 * ONE_NEAR));
        v.owner_pay("x.testnet".parse().unwrap(), U128(2 * ONE_NEAR));
    }

    #[test]
    fn cap_resets_next_day() {
        let mut v = vault();
        ctx("owner.testnet", 1, 1_000);
        v.owner_pay("x.testnet".parse().unwrap(), U128(2 * ONE_NEAR));
        ctx("owner.testnet", 1, 1_000 + MS_PER_DAY);
        v.owner_pay("x.testnet".parse().unwrap(), U128(2 * ONE_NEAR));
        assert_eq!(v.get_config().spent_today.0, 2 * ONE_NEAR);
    }
}
