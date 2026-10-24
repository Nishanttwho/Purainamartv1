-- Persist selected catalog variants separately from legacy one-price cart rows.
-- Product variant definitions and immutable order line snapshots remain in JSONB.
CREATE TABLE cart_variant_items (
  owner_id text NOT NULL,
  -- Product rows are replaced by the existing JSON snapshot function, which
  -- truncates the products table. Keep this reference at the application layer.
  product_id text NOT NULL,
  variant_id text NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 10),
  PRIMARY KEY (owner_id, product_id, variant_id)
);

CREATE INDEX cart_variant_items_product_idx ON cart_variant_items(product_id, variant_id);
