import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Actor } from '../auth/auth.js';
import { query, withTransaction } from '../db/database.js';
import { ApiError, ok } from '../lib/http.js';
import { parse, uuid } from '../lib/validation.js';

// Both the grant screen and the trainer's final save use the purchased version
// and the status of its own order line (a sibling line may have been refunded).
export const purchasedLicenceJoins = `FROM content_licenses cl
  JOIN order_items oi ON oi.order_item_id = cl.order_item_id
    AND oi.content_version_id = cl.content_version_id AND oi.seller_user_id = cl.creator_user_id
  JOIN orders o ON o.order_id = oi.order_id AND o.buyer_user_id = cl.buyer_user_id`;
export const currentPurchase = `oi.item_type = 'content_version'
  AND oi.fulfilment_status IN ('paid', 'fulfilled', 'reserved')
  AND o.paid_at IS NOT NULL AND o.order_status IN ('paid', 'partially_refunded')
  AND (cl.valid_until IS NULL OR cl.valid_until > now())`;
const ownedPurchase = `JOIN content_versions cv ON cv.content_version_id = cl.content_version_id
  JOIN contents c ON c.content_id = cv.content_id AND c.creator_user_id = cl.creator_user_id`;
const pageInput = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100), cursor: uuid.optional(),
}).strict();
const permissionInput = z.object({ courseReuseAllowed: z.boolean() }).strict();

export async function listReuseLicences(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const contentId = parse(uuid, req.params.id);
  const { cursor, limit } = parse(pageInput, req.query);
  const result = await query<{ id: string; buyer_label: string | null; order_no: string;
    version_no: number; paid_at: Date; allowed: boolean }>(`
    SELECT cl.content_license_id AS id, p.display_name AS buyer_label, o.order_no, cv.version_no,
      o.paid_at, cl.license_terms_json @> '{"courseReuseAllowed":true}' AS allowed
    ${purchasedLicenceJoins} ${ownedPurchase}
    LEFT JOIN profiles p ON p.user_id = cl.buyer_user_id
    WHERE c.content_id = $1 AND c.creator_user_id = $2 AND ${currentPurchase}
      AND ($3::uuid IS NULL OR cl.content_license_id > $3)
    ORDER BY cl.content_license_id LIMIT $4`, [contentId, actor.id, cursor ?? null, limit + 1]);
  const hasNext = result.rows.length > limit;
  const items = result.rows.slice(0, limit).map(row => ({
    id: row.id, buyerLabel: row.buyer_label, orderNo: row.order_no, version: row.version_no,
    purchasedAt: row.paid_at, courseReuseAllowed: row.allowed,
  }));
  return ok(res, items, 200, { hasNext, nextCursor: hasNext ? items[items.length - 1].id : null });
}

export async function setReuseLicence(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const contentId = parse(uuid, req.params.id);
  const licenceId = parse(uuid, req.params.licenceId);
  const { courseReuseAllowed } = parse(permissionInput, req.body);
  await withTransaction(async client => {
    const result = await client.query<{ allowed: boolean }>(`
      SELECT cl.license_terms_json @> '{"courseReuseAllowed":true}' AS allowed
      ${purchasedLicenceJoins} ${ownedPurchase}
      WHERE c.content_id = $1 AND c.creator_user_id = $2
        AND cl.content_license_id = $3 AND ${currentPurchase}
      FOR UPDATE OF cl FOR SHARE OF oi, o`, [contentId, actor.id, licenceId]);
    if (!result.rowCount) throw new ApiError(404, 'LICENCE_NOT_AVAILABLE', 'No eligible purchase licence was found.');
    if (result.rows[0].allowed === courseReuseAllowed) return;
    await client.query(`UPDATE content_licenses SET license_terms_json =
      jsonb_set(license_terms_json, '{courseReuseAllowed}', to_jsonb($2::boolean))
      WHERE content_license_id = $1`, [licenceId, courseReuseAllowed]);
    await client.query(`INSERT INTO admin_action_logs
      (actor_user_id, action_type, target_table, target_record_id, details_json, request_id)
      VALUES ($1, 'content.course_reuse.permission', 'content_licenses', $2,
        jsonb_build_object('courseReuseAllowed', $3::boolean), $4)`,
      [actor.id, licenceId, courseReuseAllowed, res.locals.requestId]);
  });
  return ok(res, { id: licenceId, courseReuseAllowed });
}
