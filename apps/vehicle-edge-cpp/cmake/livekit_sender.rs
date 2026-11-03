// These inputs are SFU-authenticated packet metadata, never application payload.
pub fn can_register(identity: &str, sid: &str, identity_exists: bool) -> bool {
    !identity.is_empty() && sid.starts_with("PA_") && sid.len() > 3 && !identity_exists
}

#[cfg(test)]
mod tests {
    use super::can_register;

    #[test]
    fn data_only_sender_can_be_registered_before_batched_signal_update() {
        assert!(can_register("control-browser", "PA_authenticated", false));
    }

    #[test]
    fn missing_metadata_is_not_inferred_from_payload() {
        assert!(!can_register("", "PA_authenticated", false));
        assert!(!can_register("control-browser", "", false));
        assert!(!can_register("control-browser", "invalid", false));
        assert!(!can_register("control-browser", "PA_", false));
    }

    #[test]
    fn existing_identity_cannot_be_replaced_by_data_packet() {
        assert!(!can_register("control-browser", "PA_new", true));
    }
}
