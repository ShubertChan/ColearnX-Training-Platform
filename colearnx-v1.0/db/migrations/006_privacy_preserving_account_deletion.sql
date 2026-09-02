-- A user record is referenced by orders, refunds, credentials, audit logs and
-- other financial records, so it cannot be physically deleted without losing
-- those records.  Redact it instead, release the original email address, and
-- hide deleted accounts from the normal administrator list.

UPDATE profiles p
SET display_name = 'Deleted account',
    phone = NULL,
    location = NULL,
    bio = NULL,
    updated_at = now()
FROM users u
WHERE p.user_id = u.user_id
  AND u.account_status = 'deleted';

UPDATE users
SET full_name = 'Deleted account',
    email = 'deleted+' || user_id::text || '@deleted.invalid',
    email_verified_at = NULL,
    email_verification_required_at = NULL,
    updated_at = now()
WHERE account_status = 'deleted';

UPDATE user_roles ur
SET revoked_at = now()
FROM users u
WHERE ur.user_id = u.user_id
  AND u.account_status = 'deleted'
  AND ur.revoked_at IS NULL;

UPDATE refresh_sessions rs
SET revoked_at = now(),
    revoke_reason = COALESCE(rs.revoke_reason, 'account-deleted')
FROM users u
WHERE rs.user_id = u.user_id
  AND u.account_status = 'deleted'
  AND rs.revoked_at IS NULL;

DELETE FROM email_verification_challenges evc
USING users u
WHERE evc.user_id = u.user_id
  AND u.account_status = 'deleted';
