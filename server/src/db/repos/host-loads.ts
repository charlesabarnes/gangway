import type { Db } from "../types.ts";

export type HostLoad = { previews: number; awakeBytes: number };

/** What every org's previews hold on each host: the containers there, and the memory awake. */
export function hostLoads(db: Db): Map<string, HostLoad> {
  const rows = db.query(
    `SELECT host_id,
            COUNT(*) AS previews,
            COALESCE(SUM(CASE WHEN state IN ('building','starting','awake')
                              THEN reserved_bytes ELSE 0 END), 0) AS awake_bytes
       FROM previews
      WHERE state != 'destroyed'
        AND NOT (source_kind = 'tarball' AND json_extract(source_json, '$.serve') IS 'gangway')
      GROUP BY host_id`,
  ) as { host_id: string; previews: number; awake_bytes: number }[];
  return new Map(rows.map((r) => [r.host_id, { previews: r.previews, awakeBytes: r.awake_bytes }]));
}
