-- Loose products have a per-unit price (for example ₹62/kg) but no reference
-- MRP. Keep packed-product MRP required while allowing NULL for loose products.
--
-- PostgreSQL names the column-level CHECK from the original schema
-- "products_mrp_check" (not "products_check"). Drop both names defensively so
-- this migration works against the original schema and any older variant.
ALTER TABLE products ALTER COLUMN mrp DROP NOT NULL;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_check;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_mrp_check;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_mrp_required_for_non_loose;

ALTER TABLE products
  ADD CONSTRAINT products_mrp_check CHECK (mrp IS NULL OR mrp >= price);
ALTER TABLE products
  ADD CONSTRAINT products_mrp_required_for_non_loose
  CHECK (mrp IS NOT NULL OR data->>'saleType' = 'loose');
