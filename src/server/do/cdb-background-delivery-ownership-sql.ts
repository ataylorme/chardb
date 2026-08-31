/**
 * SQL admission predicate for vshard-owned background work. The surrounding
 * query must alias the row carrying `placement_vshard` as `delivery_head`.
 *
 * This mirrors `CdbReshardRuntime.assertBackgroundDeliveryAdmission`: an
 * activated source fence closes delivery, while a destination range opens
 * only when its latest routing generation has exactly one serving owner that
 * has finished its destination drain.
 */
export const CDB_BACKGROUND_DELIVERY_OWNERSHIP_SQL = `(
  NOT EXISTS (
    SELECT 1 FROM _chardb_routing_fences AS source_fence
    WHERE delivery_head.placement_vshard BETWEEN source_fence.range_lo AND source_fence.range_hi
      AND source_fence.status IN ('active', 'cleaned')
  )
  AND (
    NOT EXISTS (
      SELECT 1 FROM _chardb_split_state AS destination
      WHERE destination.role = 'dest'
        AND delivery_head.placement_vshard BETWEEN destination.range_lo AND destination.range_hi
    )
    OR (
      SELECT COUNT(*) FROM _chardb_split_state AS latest_destination
      WHERE latest_destination.role = 'dest'
        AND delivery_head.placement_vshard
            BETWEEN latest_destination.range_lo AND latest_destination.range_hi
        AND latest_destination.destination_generation = (
          SELECT MAX(candidate.destination_generation)
          FROM _chardb_split_state AS candidate
          WHERE candidate.role = 'dest'
            AND delivery_head.placement_vshard BETWEEN candidate.range_lo AND candidate.range_hi
        )
        AND latest_destination.destination_serving = 1
        AND latest_destination.drained = 1
    ) = 1
    AND (
      SELECT COUNT(*) FROM _chardb_split_state AS latest_destination
      WHERE latest_destination.role = 'dest'
        AND delivery_head.placement_vshard
            BETWEEN latest_destination.range_lo AND latest_destination.range_hi
        AND latest_destination.destination_generation = (
          SELECT MAX(candidate.destination_generation)
          FROM _chardb_split_state AS candidate
          WHERE candidate.role = 'dest'
            AND delivery_head.placement_vshard BETWEEN candidate.range_lo AND candidate.range_hi
        )
    ) = 1
  )
)` as const;

/** Stop every vector delivery for an organization after one purge reaches manual-required state. */
export const CDB_VECTOR_ORGANIZATION_DELIVERY_OPEN_SQL = `NOT EXISTS (
  SELECT 1 FROM _chardb_vectors AS failed_head
    INDEXED BY _chardb_vectors_deleting_by_organization
  INNER JOIN _chardb_vector_outbox AS failed_outbox ON failed_outbox.vector_id = failed_head.vector_id
  WHERE failed_head.organization_id = delivery_head.organization_id
    AND failed_head.state = 'deleting'
    AND failed_outbox.terminal_failure = 1
    AND EXISTS (
      SELECT 1 FROM _chardb_deleted_organizations AS deleted_organization
      WHERE deleted_organization.organization_id = failed_head.organization_id
    )
)` as const;
