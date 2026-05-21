/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

// Swap the legacy app-level trace_id (UUID) for a W3C traceparent column.
// The old UUIDs cannot be re-attached as OTel parent contexts, so in-flight
// rows simply lose the original-request linkage on first publish; subsequent
// outbox rows insert with the active OTel context via propagation.inject.
exports.up = (pgm) => {
  pgm.dropColumn('orders_outbox', 'trace_id', { ifExists: true });
  pgm.addColumn(
    'orders_outbox',
    { trace_context: { type: 'text' } },
    { ifNotExists: true },
  );
};

exports.down = (pgm) => {
  pgm.dropColumn('orders_outbox', 'trace_context', { ifExists: true });
  pgm.addColumn(
    'orders_outbox',
    { trace_id: { type: 'text' } },
    { ifNotExists: true },
  );
};
