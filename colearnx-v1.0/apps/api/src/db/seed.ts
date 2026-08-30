import { pool } from './database.js';

async function main() {
  await pool.query(`INSERT INTO roles (role_code, role_name, description) VALUES
    ('member', 'Member', 'Default learning-platform member'),
    ('trainer', 'Trainer', 'Approved course trainer'),
    ('creator', 'Creator', 'Approved content creator'),
    ('admin', 'Administrator', 'Platform administrator')
    ON CONFLICT (role_code) DO UPDATE SET role_name = EXCLUDED.role_name, description = EXCLUDED.description`);
  await pool.query(`INSERT INTO categories (category_name, category_scope) VALUES
    ('Design', 'both'), ('Technology', 'both'), ('Business', 'both')
    ON CONFLICT (category_name) DO NOTHING`);
  await pool.query(`INSERT INTO payment_channels (channel_code, channel_type, provider_code, display_name, is_enabled) VALUES
    ('stripe_test', 'card', 'stripe', 'Stripe test mode', true)
    ON CONFLICT (channel_code) DO UPDATE SET channel_type = EXCLUDED.channel_type, provider_code = EXCLUDED.provider_code, display_name = EXCLUDED.display_name, is_enabled = EXCLUDED.is_enabled`);
  await pool.query(`INSERT INTO point_accounts (user_id, account_status, available_balance, frozen_balance)
    SELECT NULL, 'system', 0, 0
    WHERE NOT EXISTS (SELECT 1 FROM point_accounts WHERE account_status = 'system')`);
  // Sponsor-approved baseline: S$1 = 1 point, with no bonus or promotion.
  // The API always reads the price and point amount from this server-owned table.
  await pool.query(`INSERT INTO point_topup_packages (package_code, display_name, currency_code, fiat_amount, points_amount, is_active)
    VALUES
    ('sgd-5', 'S$5 = 5 points', 'sgd', 500, 5, true),
    ('sgd-10', 'S$10 = 10 points', 'sgd', 1000, 10, true),
    ('sgd-20', 'S$20 = 20 points', 'sgd', 2000, 20, true),
    ('sgd-50', 'S$50 = 50 points', 'sgd', 5000, 50, true)
    ON CONFLICT (package_code) DO NOTHING`);
  // Revenue splits approved for MVP: 30% platform / 70% seller. Only seed a
  // policy when that product class has no active policy; later admin choices
  // remain authoritative and are never overwritten by re-running the seed.
  await pool.query(`INSERT INTO revenue_share_policies
    (product_kind, policy_code, platform_share_bps, trainer_share_bps, creator_share_bps, is_active)
    SELECT 'course_run', 'course-platform30-trainer70-v1', 3000, 7000, 0, true
    WHERE NOT EXISTS (SELECT 1 FROM revenue_share_policies WHERE product_kind = 'course_run' AND is_active AND retired_at IS NULL)
    ON CONFLICT (policy_code) DO NOTHING`);
  await pool.query(`INSERT INTO revenue_share_policies
    (product_kind, policy_code, platform_share_bps, trainer_share_bps, creator_share_bps, is_active)
    SELECT 'content_version', 'content-platform30-creator70-v1', 3000, 0, 7000, true
    WHERE NOT EXISTS (SELECT 1 FROM revenue_share_policies WHERE product_kind = 'content_version' AND is_active AND retired_at IS NULL)
    ON CONFLICT (policy_code) DO NOTHING`);
  const bootstrapAdminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  if (bootstrapAdminEmail) {
    const granted = await pool.query<{ user_id: string }>(`INSERT INTO user_roles (user_id, role_id)
      SELECT u.user_id, r.role_id FROM users u JOIN roles r ON r.role_code = 'admin'
      WHERE lower(u.email::text) = $1
      ON CONFLICT (user_id, role_id) WHERE revoked_at IS NULL DO NOTHING
      RETURNING user_id`, [bootstrapAdminEmail]);
    if (granted.rowCount) {
      process.stdout.write(`Bootstrap admin granted for ${bootstrapAdminEmail}. Remove BOOTSTRAP_ADMIN_EMAIL after setup.\n`);
    } else {
      const user = await pool.query(`SELECT 1 FROM users WHERE lower(email::text) = $1`, [bootstrapAdminEmail]);
      process.stdout.write(user.rowCount
        ? `Bootstrap admin already exists for ${bootstrapAdminEmail}. Remove BOOTSTRAP_ADMIN_EMAIL after setup.\n`
        : `Bootstrap admin email ${bootstrapAdminEmail} has not registered yet; no role was granted.\n`);
    }
  }
  process.stdout.write('Seed completed. Active packages use S$1 = 1 point with no promotional bonus; course/content revenue shares are 30% platform and 70% seller.\n');
}

main().then(() => pool.end()).catch(async (error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  await pool.end();
  process.exitCode = 1;
});
