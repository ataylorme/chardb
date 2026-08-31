/**
 * SQL admission predicate for background file work. The surrounding query
 * must alias `_chardb_files` as `files`.
 *
 * This mirrors `CdbFileReshardStore.assertOwnership`: no transfer is owned,
 * overlapping active transfers fail closed, and the highest-priority retained
 * outcome decides whether this shard may maintain the vshard.
 */
export const CDB_FILE_MAINTENANCE_OWNERSHIP_SQL = `(
  (SELECT COUNT(*) FROM _chardb_split_file_cursor AS active_cursor
   WHERE files.placement_vshard BETWEEN active_cursor.range_lo AND active_cursor.range_hi
     AND active_cursor.outcome = 'active') <= 1
  AND COALESCE((
    SELECT CASE
      WHEN cursor.role = 'source'
       AND ((cursor.outcome = 'active' AND cursor.source_fenced = 0 AND cursor.maintenance_enabled = 1)
            OR cursor.outcome = 'aborted') THEN 1
      WHEN cursor.role = 'dest'
       AND cursor.outcome IN ('active', 'finished')
       AND cursor.maintenance_enabled = 1 THEN 1
      ELSE 0
    END
    FROM _chardb_split_file_cursor AS cursor
    WHERE files.placement_vshard BETWEEN cursor.range_lo AND cursor.range_hi
    ORDER BY CASE cursor.outcome WHEN 'active' THEN 0 ELSE 1 END,
             cursor.updated_at DESC,
             cursor.mig_id DESC
    LIMIT 1
  ), 1) = 1
)` as const;
