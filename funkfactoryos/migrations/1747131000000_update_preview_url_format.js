// Updates sunrise-bakery-4821 preview_url from subdomain-based to path-based format.
// WHY: preview URL format changed to path-based (preview.funkfactorymediagroup.com/job-id).

module.exports = {
  up: async (pool) => {
    await pool.query(
      `UPDATE customers
       SET preview_url = 'https://preview.funkfactorymediagroup.com/sunrise-bakery-4821'
       WHERE job_id = 'sunrise-bakery-4821'
         AND preview_url = 'https://sunrise-bakery-4821.preview.funkfactorymediagroup.com'`
    );
  },
  down: async (pool) => {
    await pool.query(
      `UPDATE customers
       SET preview_url = 'https://sunrise-bakery-4821.preview.funkfactorymediagroup.com'
       WHERE job_id = 'sunrise-bakery-4821'
         AND preview_url = 'https://preview.funkfactorymediagroup.com/sunrise-bakery-4821'`
    );
  }
};
