-- The publishing tools use a course-run-level selection before a future
-- curriculum editor assigns licensed resources to individual modules.  Keep
-- that selection separate from course_module_contents so no artificial module
-- needs to be created just to preserve a creator's draft choices.
CREATE TABLE course_run_content_resources (
  course_run_content_resource_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_run_id uuid NOT NULL REFERENCES course_runs(course_run_id) ON DELETE RESTRICT,
  content_version_id uuid NOT NULL REFERENCES content_versions(content_version_id) ON DELETE RESTRICT,
  content_license_id uuid REFERENCES content_licenses(content_license_id) ON DELETE RESTRICT,
  added_by_user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_run_id, content_version_id)
);

CREATE INDEX course_run_content_resources_run_idx
  ON course_run_content_resources (course_run_id, created_at ASC);

-- Content purchases made before the API began recording licence rows remain
-- usable by the buyer. They receive the same personal-access terms as new
-- purchases: reuse inside another course stays false unless a commercial
-- licence explicitly sets courseReuseAllowed to true.
INSERT INTO content_licenses
  (content_version_id, order_item_id, buyer_user_id, creator_user_id, license_code, license_terms_json)
SELECT oi.content_version_id, oi.order_item_id, o.buyer_user_id, oi.seller_user_id,
  'LIC-' || oi.order_item_id::text,
  jsonb_build_object('courseReuseAllowed', false)
FROM order_items oi
JOIN orders o ON o.order_id = oi.order_id
WHERE oi.item_type = 'content_version'
  AND oi.content_version_id IS NOT NULL
  AND oi.fulfilment_status NOT IN ('refunded', 'cancelled')
  AND o.order_status NOT IN ('refunded', 'cancelled')
  AND NOT EXISTS (
    SELECT 1 FROM content_licenses cl WHERE cl.order_item_id = oi.order_item_id
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON course_run_content_resources TO colearnx_app;
