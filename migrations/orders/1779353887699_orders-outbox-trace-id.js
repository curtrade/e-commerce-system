/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn(
    'orders_outbox',
    { trace_id: { type: 'text' } },
    { ifNotExists: true },
  );
  // Backfill in-flight rows so the publisher emits a stable traceId on the
  // first attempt instead of minting a fresh UUID per retry.
  pgm.sql(`
    UPDATE orders_outbox
       SET trace_id = id::text
     WHERE trace_id IS NULL
       AND published_at IS NULL
  `);
};

exports.down = (pgm) => {
  pgm.dropColumn('orders_outbox', 'trace_id', { ifExists: true });
};
