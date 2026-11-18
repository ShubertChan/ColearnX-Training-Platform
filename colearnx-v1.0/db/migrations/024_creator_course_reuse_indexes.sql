CREATE INDEX contents_creator_content_idx ON contents (creator_user_id, content_id);
CREATE INDEX content_licenses_version_licence_idx ON content_licenses (content_version_id, content_license_id);
CREATE INDEX content_licenses_buyer_version_idx ON content_licenses (buyer_user_id, content_version_id);
CREATE INDEX course_run_resources_version_run_idx
  ON course_run_content_resources (content_version_id, course_run_id);
CREATE INDEX course_module_contents_version_module_idx
  ON course_module_contents (content_version_id, module_id) WHERE content_version_id IS NOT NULL;
CREATE INDEX course_module_contents_licence_module_idx
  ON course_module_contents (content_license_id, module_id)
  WHERE content_version_id IS NULL AND content_license_id IS NOT NULL;
