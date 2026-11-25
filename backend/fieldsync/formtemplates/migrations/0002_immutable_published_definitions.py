"""DB-level guarantee that published template definitions never change (ADD §8.2).

The service layer already refuses; the trigger protects against admin edits, scripts and
future code paths. Status transitions (published → superseded → retired) remain allowed.
"""

from __future__ import annotations

from django.db import migrations

FORWARD = """
CREATE OR REPLACE FUNCTION form_templates_guard_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'draft' AND (
       NEW.definition IS DISTINCT FROM OLD.definition
    OR NEW.definition_hash IS DISTINCT FROM OLD.definition_hash
    OR NEW.code IS DISTINCT FROM OLD.code
    OR NEW.version IS DISTINCT FROM OLD.version
  ) THEN
    RAISE EXCEPTION 'form template % v% is % and immutable', OLD.code, OLD.version, OLD.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status <> 'draft' AND NEW.status = 'draft' THEN
    RAISE EXCEPTION 'form template % v% cannot return to draft', OLD.code, OLD.version
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER form_templates_immutable
BEFORE UPDATE ON form_templates
FOR EACH ROW EXECUTE FUNCTION form_templates_guard_immutable();
"""

REVERSE = """
DROP TRIGGER IF EXISTS form_templates_immutable ON form_templates;
DROP FUNCTION IF EXISTS form_templates_guard_immutable();
"""


class Migration(migrations.Migration):
    dependencies = [("formtemplates", "0001_initial")]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
