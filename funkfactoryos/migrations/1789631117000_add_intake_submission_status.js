module.exports = {
  name: 'add_intake_submission_status',
  up: async (client) => {
    await client.query(`
      ALTER TABLE intake_submissions
      ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'new'
    `);

    await client.query(`
      UPDATE intake_submissions
      SET status = 'new'
      WHERE status IS NULL
    `);

    await client.query(`
      ALTER TABLE intake_submissions
      ALTER COLUMN status SET DEFAULT 'new',
      ALTER COLUMN status SET NOT NULL
    `);

    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid = 'intake_submissions'::regclass
            AND conname = 'intake_submissions_status_check'
        ) THEN
          ALTER TABLE intake_submissions
          ADD CONSTRAINT intake_submissions_status_check
          CHECK (status IN ('new', 'contacted', 'qualified', 'closed'));
        END IF;
      END $$;
    `);
  }
};
