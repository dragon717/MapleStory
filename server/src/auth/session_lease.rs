use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

pub(crate) struct SessionLease {
    expires_at: Instant,
    revoked: AtomicBool,
}

impl SessionLease {
    pub(crate) fn new(expires_at: Instant) -> Self {
        Self {
            expires_at,
            revoked: AtomicBool::new(false),
        }
    }

    pub(crate) fn valid(&self) -> bool {
        Instant::now() < self.expires_at && !self.revoked.load(Ordering::Acquire)
    }

    pub(crate) fn revoke(&self) {
        self.revoked.store(true, Ordering::Release);
    }

    pub(crate) fn expires_at(&self) -> Instant {
        self.expires_at
    }
}

#[derive(Clone)]
pub(crate) struct Authorization {
    pub identity: super::Identity,
    pub gm: bool,
    pub lease: Arc<SessionLease>,
}

#[cfg(test)]
mod tests {
    use super::SessionLease;
    use std::{sync::Arc, time::Duration};

    #[test]
    fn lease_is_valid_before_its_deadline() {
        let expires_at = std::time::Instant::now() + Duration::from_secs(60);
        let lease = SessionLease::new(expires_at);

        assert!(lease.valid());
        assert_eq!(lease.expires_at(), expires_at);
    }

    #[test]
    fn lease_is_invalid_at_its_deadline() {
        let lease = SessionLease::new(std::time::Instant::now());

        assert!(!lease.valid());
    }

    #[test]
    fn revoke_is_idempotent_and_shared_by_arc_clones() {
        let lease = Arc::new(SessionLease::new(
            std::time::Instant::now() + Duration::from_secs(60),
        ));
        let shared_lease = Arc::clone(&lease);

        lease.revoke();
        lease.revoke();

        assert!(!shared_lease.valid());
    }
}
