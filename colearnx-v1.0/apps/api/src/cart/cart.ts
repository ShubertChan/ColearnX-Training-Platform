import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Actor } from '../auth/auth.js';
import { query, withTransaction } from '../db/database.js';
import { ApiError, ok } from '../lib/http.js';
import { parse, uuid } from '../lib/validation.js';

const cartItemInput = z.object({ kind: z.enum(['course', 'content']), id: uuid }).strict();

function requireBuyer(actor: Actor) {
  if (!actor.roles.includes('member') || actor.roles.includes('admin')) {
    throw new ApiError(403, 'MEMBER_PURCHASE_REQUIRED', 'A non-administrator Member account is required to use the cart.');
  }
}

async function activeCart(client: PoolClient, userId: string) {
  const cart = await client.query<{ cart_id: string }>(`INSERT INTO carts (buyer_user_id) VALUES ($1)
    ON CONFLICT (buyer_user_id) WHERE cart_status = 'active' DO UPDATE SET updated_at = now() RETURNING cart_id`, [userId]);
  return cart.rows[0].cart_id;
}

async function cartProduct(client: PoolClient, item: z.infer<typeof cartItemInput>) {
  if (item.kind === 'course') {
    const course = await client.query<{ id: string; seller_user_id: string; title: string; price_points: string }>(`SELECT cr.course_run_id AS id,
      c.owner_user_id AS seller_user_id, c.title, cr.price_points FROM course_runs cr JOIN courses c ON c.course_id = cr.course_id
      WHERE cr.course_run_id = $1 AND cr.run_status = 'published' AND c.publication_status = 'published'`, [item.id]);
    if (!course.rowCount) throw new ApiError(404, 'COURSE_NOT_AVAILABLE', 'This course is not available.');
    return { itemType: 'course_run', ...course.rows[0], policy: { rule: 'delivery-snapshot-v1' } };
  }
  const content = await client.query<{ id: string; seller_user_id: string; title: string; price_points: string }>(`SELECT cv.content_version_id AS id,
    c.creator_user_id AS seller_user_id, c.title, c.price_points FROM content_versions cv JOIN contents c ON c.content_id = cv.content_id
    WHERE cv.content_version_id = $1 AND cv.version_status = 'published' AND c.publication_status = 'published'`, [item.id]);
  if (!content.rowCount) throw new ApiError(404, 'CONTENT_NOT_AVAILABLE', 'This content is not available.');
  return { itemType: 'content_version', ...content.rows[0], policy: { rule: 'content-delivery-v1' } };
}

export async function listCart(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  requireBuyer(actor);
  const result = await query(`SELECT ci.cart_item_id, ci.item_type, ci.course_run_id, ci.content_version_id, ci.seller_user_id,
      ci.last_seen_price_points, ci.policy_preview_snapshot_json, ci.added_at,
      COALESCE(course.title, content.title) AS title, seller.full_name AS seller_name
    FROM carts c JOIN cart_items ci ON ci.cart_id = c.cart_id LEFT JOIN users seller ON seller.user_id = ci.seller_user_id
    LEFT JOIN course_runs cr ON cr.course_run_id = ci.course_run_id LEFT JOIN courses course ON course.course_id = cr.course_id
    LEFT JOIN content_versions cv ON cv.content_version_id = ci.content_version_id LEFT JOIN contents content ON content.content_id = cv.content_id
    WHERE c.buyer_user_id = $1 AND c.cart_status = 'active' ORDER BY ci.added_at ASC, ci.cart_item_id ASC`, [actor.id]);
  return ok(res, { items: result.rows.map((item) => ({ id: item.cart_item_id, kind: item.item_type === 'course_run' ? 'course' : 'content',
    productId: item.course_run_id ?? item.content_version_id, title: item.title, pricePoints: Number(item.last_seen_price_points),
    seller: { id: item.seller_user_id, displayName: item.seller_name }, policyPreview: item.policy_preview_snapshot_json, addedAt: item.added_at })) });
}

export async function addCartItem(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  requireBuyer(actor);
  const item = parse(cartItemInput, req.body);
  const result = await withTransaction(async (client) => {
    const product = await cartProduct(client, item);
    if (product.seller_user_id === actor.id) throw new ApiError(403, 'OWN_PRODUCT_PURCHASE_FORBIDDEN', 'You cannot add your own product to the cart.');
    const cartId = await activeCart(client, actor.id);
    await client.query(`DELETE FROM cart_items WHERE cart_id = $1 AND (course_run_id = $2 OR content_version_id = $2)`,
    [cartId, item.id]);
    const stored = await client.query<{ cart_item_id: string }>(`INSERT INTO cart_items
      (cart_id, item_type, course_run_id, content_version_id, seller_user_id, last_seen_price_points, policy_preview_snapshot_json)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      RETURNING cart_item_id`, [cartId, product.itemType, item.kind === 'course' ? item.id : null, item.kind === 'content' ? item.id : null,
      product.seller_user_id, product.price_points, JSON.stringify(product.policy)]);
    await client.query('UPDATE carts SET updated_at = now() WHERE cart_id = $1', [cartId]);
    return { id: stored.rows[0].cart_item_id, kind: item.kind, productId: item.id };
  });
  return ok(res, result, 201);
}

export async function removeCartItem(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  requireBuyer(actor);
  const cartItemId = parse(uuid, req.params.id);
  const result = await query(`DELETE FROM cart_items ci USING carts c
    WHERE ci.cart_item_id = $1 AND ci.cart_id = c.cart_id AND c.buyer_user_id = $2 AND c.cart_status = 'active' RETURNING ci.cart_item_id`, [cartItemId, actor.id]);
  if (!result.rowCount) throw new ApiError(404, 'CART_ITEM_NOT_FOUND', 'Cart item was not found.');
  return ok(res, { id: cartItemId, removed: true });
}
