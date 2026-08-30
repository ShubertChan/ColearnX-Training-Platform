import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Actor } from '../auth/auth.js';
import { query, withTransaction } from '../db/database.js';
import { ApiError, ok } from '../lib/http.js';
import { parse, uuid } from '../lib/validation.js';

const roleApplicationInput = z.object({
  requestedRole: z.enum(['trainer', 'creator']),
  supportingText: z.string().trim().min(20).max(4_000),
});
const certificationInput = z.object({
  certificationName: z.string().trim().min(2).max(200),
  certificationReference: z.string().trim().max(300).optional(),
  evidenceUrl: z.string().url().max(2_000).optional(),
});
const decisionInput = z.object({
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().trim().min(3).max(2_000),
});
const listInput = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

function applicationResponse(row: Record<string, unknown>) {
  return {
    id: row.application_id,
    requestedRole: row.role_code,
    status: row.application_status,
    supportingText: row.supporting_text,
    submittedAt: row.submitted_at,
    reviewedAt: row.reviewed_at,
    reviewComment: row.review_comment,
    applicant: row.applicant_user_id ? { id: row.applicant_user_id, displayName: row.applicant_name } : undefined,
  };
}

function certificationResponse(row: Record<string, unknown>) {
  return {
    id: row.trainer_certification_id,
    certificationName: row.certification_name,
    certificationReference: row.certification_reference,
    evidenceUrl: row.evidence_url,
    status: row.certification_status,
    submittedAt: row.submitted_at,
    reviewedAt: row.reviewed_at,
    reviewComment: row.review_comment,
    trainer: row.trainer_user_id ? { id: row.trainer_user_id, displayName: row.trainer_name } : undefined,
  };
}

export async function createRoleApplication(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const input = parse(roleApplicationInput, req.body);
  const created = await withTransaction(async (client) => {
    const role = await client.query<{ role_id: string }>(`SELECT role_id FROM roles WHERE role_code = $1`, [input.requestedRole]);
    if (!role.rowCount) throw new ApiError(503, 'ROLE_CONFIGURATION_INVALID', 'The requested role is not configured.');
    const assigned = await client.query(`SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = $2 AND revoked_at IS NULL`, [actor.id, role.rows[0].role_id]);
    if (assigned.rowCount) throw new ApiError(409, 'ROLE_ALREADY_GRANTED', 'You already hold this role.');
    const result = await client.query<{ application_id: string; application_status: string; submitted_at: Date }>(`INSERT INTO role_applications
      (applicant_user_id, requested_role_id, supporting_text)
      VALUES ($1, $2, $3) RETURNING application_id, application_status, submitted_at`, [actor.id, role.rows[0].role_id, input.supportingText]);
    await client.query(`INSERT INTO admin_action_logs (actor_user_id, action_type, target_table, target_record_id, details_json, request_id)
      VALUES ($1, 'role_application.submit', 'role_applications', $2, jsonb_build_object('requestedRole', $3::text), $4)`,
      [actor.id, result.rows[0].application_id, input.requestedRole, res.locals.requestId]);
    return result.rows[0];
  });
  return ok(res, { id: created.application_id, status: created.application_status, submittedAt: created.submitted_at }, 201);
}

export async function myRoleApplications(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const result = await query(`SELECT ra.application_id, r.role_code, ra.application_status, ra.supporting_text,
    ra.submitted_at, ra.reviewed_at, ra.review_comment
    FROM role_applications ra JOIN roles r ON r.role_id = ra.requested_role_id
    WHERE ra.applicant_user_id = $1 ORDER BY ra.submitted_at DESC, ra.application_id DESC`, [actor.id]);
  return ok(res, result.rows.map(applicationResponse));
}

export async function listRoleApplications(req: Request, res: Response) {
  const input = parse(listInput, req.query);
  const result = await query(`SELECT ra.application_id, ra.applicant_user_id, u.full_name AS applicant_name, r.role_code,
    ra.application_status, ra.supporting_text, ra.submitted_at, ra.reviewed_at, ra.review_comment
    FROM role_applications ra JOIN roles r ON r.role_id = ra.requested_role_id
    JOIN users u ON u.user_id = ra.applicant_user_id
    WHERE ($1::text IS NULL OR ra.application_status = $1)
    ORDER BY ra.submitted_at ASC, ra.application_id ASC LIMIT $2`, [input.status ?? null, input.limit]);
  return ok(res, result.rows.map(applicationResponse));
}

export async function decideRoleApplication(req: Request, res: Response) {
  const admin = res.locals.actor as Actor;
  const applicationId = parse(uuid, req.params.id);
  const input = parse(decisionInput, req.body);
  const response = await withTransaction(async (client) => {
    const application = await client.query<{ applicant_user_id: string; requested_role_id: string; role_code: string; application_status: string }>(`SELECT
      ra.applicant_user_id, ra.requested_role_id, r.role_code, ra.application_status
      FROM role_applications ra JOIN roles r ON r.role_id = ra.requested_role_id
      WHERE ra.application_id = $1 FOR UPDATE OF ra`, [applicationId]);
    if (!application.rowCount) throw new ApiError(404, 'ROLE_APPLICATION_NOT_FOUND', 'Role application was not found.');
    const current = application.rows[0];
    if (current.application_status !== 'pending') throw new ApiError(409, 'ROLE_APPLICATION_ALREADY_DECIDED', 'This role application has already been decided.');
    await client.query(`UPDATE role_applications SET application_status = $2, reviewer_user_id = $3,
      reviewed_at = now(), review_comment = $4 WHERE application_id = $1`, [applicationId, input.decision, admin.id, input.reason]);
    if (input.decision === 'approved') {
      await client.query(`INSERT INTO user_roles (user_id, role_id, assigned_by_user_id)
        VALUES ($1, $2, $3) ON CONFLICT (user_id, role_id) WHERE revoked_at IS NULL DO NOTHING`,
        [current.applicant_user_id, current.requested_role_id, admin.id]);
    }
    await client.query(`INSERT INTO admin_action_logs (actor_user_id, action_type, target_table, target_record_id, details_json, request_id)
      VALUES ($1, 'role_application.decision', 'role_applications', $2,
      jsonb_build_object('decision', $3::text, 'requestedRole', $4::text, 'outcome', 'success'), $5)`,
      [admin.id, applicationId, input.decision, current.role_code, res.locals.requestId]);
    return { id: applicationId, status: input.decision, requestedRole: current.role_code };
  });
  return ok(res, response);
}

export async function createTrainerCertification(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const input = parse(certificationInput, req.body);
  if (!actor.roles.includes('trainer')) throw new ApiError(403, 'TRAINER_ROLE_REQUIRED', 'An approved trainer role is required.');
  const created = await withTransaction(async (client) => {
    const result = await client.query<{ trainer_certification_id: string; certification_status: string; submitted_at: Date }>(`INSERT INTO trainer_certifications
      (trainer_user_id, certification_name, certification_reference, evidence_url)
      VALUES ($1, $2, $3, $4) RETURNING trainer_certification_id, certification_status, submitted_at`,
      [actor.id, input.certificationName, input.certificationReference ?? null, input.evidenceUrl ?? null]);
    await client.query(`INSERT INTO admin_action_logs (actor_user_id, action_type, target_table, target_record_id, request_id)
      VALUES ($1, 'trainer_certification.submit', 'trainer_certifications', $2, $3)`, [actor.id, result.rows[0].trainer_certification_id, res.locals.requestId]);
    return result.rows[0];
  });
  return ok(res, { id: created.trainer_certification_id, status: created.certification_status, submittedAt: created.submitted_at }, 201);
}

export async function myTrainerCertifications(req: Request, res: Response) {
  const actor = res.locals.actor as Actor;
  const result = await query(`SELECT trainer_certification_id, certification_name, certification_reference, evidence_url,
    certification_status, submitted_at, reviewed_at, review_comment
    FROM trainer_certifications WHERE trainer_user_id = $1 ORDER BY submitted_at DESC, trainer_certification_id DESC`, [actor.id]);
  return ok(res, result.rows.map(certificationResponse));
}

export async function listTrainerCertifications(req: Request, res: Response) {
  const input = parse(listInput, req.query);
  const result = await query(`SELECT tc.trainer_certification_id, tc.trainer_user_id, u.full_name AS trainer_name,
    tc.certification_name, tc.certification_reference, tc.evidence_url, tc.certification_status,
    tc.submitted_at, tc.reviewed_at, tc.review_comment
    FROM trainer_certifications tc JOIN users u ON u.user_id = tc.trainer_user_id
    WHERE ($1::text IS NULL OR tc.certification_status = $1)
    ORDER BY tc.submitted_at ASC, tc.trainer_certification_id ASC LIMIT $2`, [input.status ?? null, input.limit]);
  return ok(res, result.rows.map(certificationResponse));
}

export async function decideTrainerCertification(req: Request, res: Response) {
  const admin = res.locals.actor as Actor;
  const certificationId = parse(uuid, req.params.id);
  const input = parse(decisionInput, req.body);
  const response = await withTransaction(async (client) => {
    const certification = await client.query<{ trainer_user_id: string; certification_status: string }>(`SELECT trainer_user_id, certification_status
      FROM trainer_certifications WHERE trainer_certification_id = $1 FOR UPDATE`, [certificationId]);
    if (!certification.rowCount) throw new ApiError(404, 'TRAINER_CERTIFICATION_NOT_FOUND', 'Trainer certification was not found.');
    if (certification.rows[0].certification_status !== 'pending') throw new ApiError(409, 'TRAINER_CERTIFICATION_ALREADY_DECIDED', 'This trainer certification has already been decided.');
    await client.query(`UPDATE trainer_certifications SET certification_status = $2, reviewed_by_user_id = $3,
      reviewed_at = now(), review_comment = $4 WHERE trainer_certification_id = $1`, [certificationId, input.decision, admin.id, input.reason]);
    await client.query(`INSERT INTO admin_action_logs (actor_user_id, action_type, target_table, target_record_id, details_json, request_id)
      VALUES ($1, 'trainer_certification.decision', 'trainer_certifications', $2,
      jsonb_build_object('decision', $3::text, 'outcome', 'success'), $4)`, [admin.id, certificationId, input.decision, res.locals.requestId]);
    return { id: certificationId, status: input.decision };
  });
  return ok(res, response);
}
