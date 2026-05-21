/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn(
    'orders_outbox',
    { trace_id: { type: 'text' } },
    { ifNotExists: true },
  );
};

exports.down = (pgm) => {
  pgm.dropColumn('orders_outbox', 'trace_id', { ifExists: true });
};
