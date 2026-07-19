import { EntityManager } from 'typeorm';

/**
 * Generate the next task code for a ship+board: "<PREFIX>-<M|G><seq>", e.g.
 * "SWX-M0421". Prefix = the ship's asset-register majority prefix (the token
 * before the first dot of asset_id_internal, "SWX." style), falling back to
 * the ship name's first letters. Sequence is per ship+board, zero-padded to 4.
 *
 * Same optimistic model as the asset id generator: concurrent creates could
 * race for a sequence number; the partial unique index on (ship_id, task_code)
 * is the backstop — callers may retry once on a unique violation.
 */
export async function nextTaskCode(
  manager: EntityManager,
  shipId: string,
  board: string,
): Promise<string | null> {
  const prefixRows: Array<{ p: string }> = await manager.query(
    `SELECT split_part(asset_id_internal, '.', 1) AS p
       FROM assets
      WHERE ship_id = $1
        AND asset_id_internal ~ '^[A-Za-z][A-Za-z0-9]*\\.'
      GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`,
    [shipId],
  );
  let prefix = prefixRows[0]?.p ?? null;
  if (!prefix) {
    const shipRows: Array<{ name: string }> = await manager.query(
      `SELECT name FROM ships WHERE id = $1`,
      [shipId],
    );
    prefix =
      (shipRows[0]?.name ?? '')
        .replace(/[^A-Za-z]/g, '')
        .slice(0, 3)
        .toUpperCase() || 'SHIP';
  }

  const letter = board === 'general' ? 'G' : 'M';
  const head = `${prefix}-${letter}`;
  const maxRows: Array<{ m: number | null }> = await manager.query(
    `SELECT MAX(substring(task_code FROM length($2) + 1)::int) AS m
       FROM pms_tasks
      WHERE ship_id = $1 AND task_code LIKE $2 || '%'
        AND substring(task_code FROM length($2) + 1) ~ '^[0-9]+$'`,
    [shipId, head],
  );
  const seq = (Number(maxRows[0]?.m) || 0) + 1;
  return `${head}${String(seq).padStart(4, '0')}`;
}
